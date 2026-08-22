# COS 自定义域名 static.buchuqin.com 与 HTTPS 自动续期

> 实施日期：2026-08-22。记录 COS 源站域名绑定 + Let's Encrypt 证书全自动续期（acme.sh + 腾讯云 SSL 部署 API）的完整方法与踩坑，供后续域名/证书运维复用。

## 背景与方案选型

COS 桶 `buchuqin-1462767498`（ap-guangzhou）需要自定义域名 `static.buchuqin.com` 提供静态资源 HTTPS 服务。证书方案的取舍：

| 方案 | 自动续期 | 结论 |
|---|---|---|
| 1Panel 签发后手动迁到腾讯云 | ❌（面板只自动 reload 本机 nginx，迁出的副本不跟新） | 不采用 |
| 腾讯云免费 DV 证书手动续 | ❌（2024-04-25 起免费证书只有 **3 个月**，每 80 天控制台手动重申请+重绑） | 不采用 |
| **acme.sh 自动签发 + SSL 部署 API 自动推送** | ✅（cron 全自动，无需人工） | **采用** |

COS 源站域名（CNAME 直连桶，非 CDN 加速域名）的证书绑定**没有公开的 COS API**（`PUT Bucket domain` 不含证书字段），唯一 API 通道是 SSL 证书服务的部署接口，见下文。

## 架构

```
Let's Encrypt（90 天）
  ↑ DNS-01 验证（DNSPod API 自动加删 TXT）
acme.sh（服务器 /root/.acme.sh，cron 每天 4/10/16/22 点检查）
  ↓ --install-cert 落盘 /opt/buchuqin/certs/static.buchuqin.com/
  ↓ --reloadcmd 触发
/opt/buchuqin/certs/push-static-cert.py（python3 纯标准库，TC3 签名）
  ① ssl UploadCertificate          → 新 CertId
  ② ssl DeployCertificateInstance  → 部署到 COS（ResourceType=cos）
  ③ 轮询 DescribeHostDeployRecordDetail 确认
  ④ ssl DeleteCertificate          → 清理上一张（状态文件 .last-cert-id）
```

## 前置条件

1. **DNS**：`static.buchuqin.com` CNAME → `buchuqin-1462767498.cos.ap-guangzhou.myqcloud.com`（buchuqin.com 已备案，NS 在 DNSPod）
2. **凭证**：一对有效的腾讯云 SecretId/SecretKey，需要权限：DNSPod 解析读写（签发用）+ `ssl:UploadCertificate/DeployCertificateInstance/DeleteCertificate`（推送用）。本实施复用 1Panel 的 DNS 账号 `buchuqin-test`（存于 `/opt/1panel/db/agent.db` 表 `website_dns_accounts`，`authorization` 字段为明文 JSON，root 可读）
3. **服务器**：acme.sh（`/root/.acme.sh/acme.sh`，v3.1.5+）、python3、root 权限

## 实施步骤

### 1. 签发证书（DNS 验证）

```bash
# 凭证从 1Panel 库提取（只在进程内传递，不打印）
eval "$(sqlite3 /opt/1panel/db/agent.db \
  "select authorization from website_dns_accounts where name='buchuqin-test';" | \
  python3 -c 'import json,sys; d=json.load(sys.stdin); print("SID=%s SKEY=%s" % (json.dumps(d["secretID"]), json.dumps(d["secretKey"])))')"

# ⚠️ v3.1.5 插件环境变量是 Tencent_SecretId/Tencent_SecretKey（新版 acme.sh 才是 TENCENTCLOUD_*）
export Tencent_SecretId="$SID" Tencent_SecretKey="$SKEY"

/root/.acme.sh/acme.sh --issue --dns dns_tencent -d static.buchuqin.com \
  --keylength ec-256 --server letsencrypt
```

签发成功后凭证会自动存入 acme.sh 账号配置，后续续期不再依赖手工 export。

### 2. 落盘 + 注册推送钩子

```bash
mkdir -p /opt/buchuqin/certs/static.buchuqin.com
cp push-static-cert.py /opt/buchuqin/certs/ && chmod 700 /opt/buchuqin/certs/push-static-cert.py

/root/.acme.sh/acme.sh --install-cert -d static.buchuqin.com --ecc \
  --fullchain-file /opt/buchuqin/certs/static.buchuqin.com/fullchain.pem \
  --key-file      /opt/buchuqin/certs/static.buchuqin.com/privkey.pem \
  --reloadcmd 'python3 /opt/buchuqin/certs/push-static-cert.py'
```

`--install-cert` 首次执行即触发一次 reloadcmd（推送证书到腾讯云）；此后每次 cron 自动续期都会走同样链路。

### 3. 验证

```bash
echo | openssl s_client -connect static.buchuqin.com:443 -servername static.buchuqin.com \
  | openssl x509 -noout -subject -enddate
# 期望：subject=CN = static.buchuqin.com；过期时间约 90 天后

curl -sS -o /dev/null -w '%{http_code}\n' https://static.buchuqin.com/app/product/dhb/3499016.png
# 期望：200
```

## push-static-cert.py（全文）

```python
#!/usr/bin/env python3
"""static.buchuqin.com 证书推送腾讯云（acme.sh reloadcmd 调用）

链路：ssl UploadCertificate（拿新 CertId）
   → ssl DeployCertificateInstance（ResourceType=cos，部署到存储桶自定义域名）
   → 轮询 DescribeHostDeployRecordDetail 确认部署成功
   → ssl DeleteCertificate（清理上一张，失败不影响主流程）

凭证：复用 1Panel DNS 账号 buchuqin-test（agent.db 明文 JSON，root 可读）。
"""
import json
import sqlite3
import time
from hashlib import sha256
from hmac import HMAC
from urllib.request import Request, urlopen

CERT_DIR = "/opt/buchuqin/certs/static.buchuqin.com"
STATE_FILE = "/opt/buchuqin/certs/static.buchuqin.com.last-cert-id"
DOMAIN = "static.buchuqin.com"
BUCKET = "buchuqin-1462767498"
REGION = "ap-guangzhou"
INSTANCE = "%s|%s|%s" % (REGION, BUCKET, DOMAIN)


def load_creds():
    row = sqlite3.connect("/opt/1panel/db/agent.db").execute(
        "select authorization from website_dns_accounts where name='buchuqin-test'"
    ).fetchone()
    if not row:
        raise SystemExit("no dns account buchuqin-test in 1panel db")
    d = json.loads(row[0])
    return d["secretID"], d["secretKey"]


def tc3(secret_id, secret_key, service, host, action, payload, version, region=None):
    ts = int(time.time())
    date = time.strftime("%Y-%m-%d", time.gmtime(ts))
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    canonical = "POST\n/\n\ncontent-type:application/json\nhost:%s\n\ncontent-type;host\n%s" % (
        host, sha256(body.encode()).hexdigest())
    cred_scope = "%s/%s/tc3_request" % (date, service)
    string_to_sign = "TC3-HMAC-SHA256\n%d\n%s\n%s" % (
        ts, cred_scope, sha256(canonical.encode()).hexdigest())
    def h(key, msg):
        return HMAC(key, msg.encode(), sha256).digest()
    k = h(h(h(h(("TC3" + secret_key).encode(), date), service), "tc3_request"), string_to_sign)
    auth = ("TC3-HMAC-SHA256 Credential=%s/%s, SignedHeaders=content-type;host, Signature=%s"
            % (secret_id, cred_scope, k.hex()))
    headers = {"Content-Type": "application/json", "Host": host,
               "X-TC-Action": action, "X-TC-Timestamp": str(ts),
               "X-TC-Version": version, "Authorization": auth}
    if region:
        headers["X-TC-Region"] = region
    req = Request("https://%s/" % host, data=body.encode(), headers=headers)
    with urlopen(req, timeout=30) as r:
        return json.load(r)["Response"]


def main():
    sid, skey = load_creds()

    def ssl_api(action, payload):
        return tc3(sid, skey, "ssl", "ssl.tencentcloudapi.com", action, payload,
                   "2019-12-05", region=REGION)

    # 1. 上传新证书
    with open("%s/fullchain.pem" % CERT_DIR) as f:
        pub = f.read()
    with open("%s/privkey.pem" % CERT_DIR) as f:
        priv = f.read()
    up = ssl_api("UploadCertificate", {
        "CertificatePublicKey": pub, "CertificatePrivateKey": priv,
        "Alias": "auto-%s-%s" % (DOMAIN, time.strftime("%Y%m%d")),
        "Repeatable": True,
    })
    if up.get("Error"):
        raise SystemExit("UploadCertificate: %s" % up["Error"])
    new_cert = up["CertificateId"]
    print("uploaded cert %s" % new_cert)

    # 2. 部署到 COS 自定义域名
    dep = ssl_api("DeployCertificateInstance", {
        "CertificateId": new_cert, "ResourceType": "cos", "InstanceIdList": [INSTANCE]})
    if dep.get("Error"):
        raise SystemExit("DeployCertificateInstance: %s" % dep["Error"])
    record = str(dep["DeployRecordId"])
    print("deploy record %s status %s" % (record, dep["DeployStatus"]))

    # 3. 轮询部署结果（一般几秒到几十秒）
    for _ in range(12):
        time.sleep(10)
        d = ssl_api("DescribeHostDeployRecordDetail", {"DeployRecordId": record})
        st = (d.get("DeployRecordDetailList") or [{}])[0].get("Status")
        print("deploy status: %s" % st)
        if st == 1:  # 1=成功
            break
        if st in (2,):  # 失败
            raise SystemExit("deploy failed: %s" % json.dumps(d, ensure_ascii=False)[:400])
    else:
        print("WARN: deploy still pending after 2min, check SSL console")

    # 4. 清理上一张（失败不影响主流程）
    try:
        with open(STATE_FILE) as f:
            old = f.read().strip()
        if old and old != new_cert:
            dele = ssl_api("DeleteCertificate", {"CertificateId": old})
            print("old cert %s deleted: %s" % (
                old, "ok" if not dele.get("Error") else dele["Error"]))
    except FileNotFoundError:
        pass
    with open(STATE_FILE, "w") as f:
        f.write(new_cert)
    print("push done: %s -> cert %s" % (DOMAIN, new_cert))


if __name__ == "__main__":
    main()
```

## 踩坑记录（复用前必读）

1. **腾讯云 API 键名不统一**：`UploadCertificate` 返回的是 `CertificateId`，而 CDN `DescribeDomainsConfig` 里叫 `CertId`——按接口逐个核对，别想当然
2. **`DeployRecordId` 必须传字符串**：传 int 报 InvalidParameter，轮询会一直拿不到状态
3. **cos 资源类型必须传公共参数 `X-TC-Region`**（tc3 函数的 region 参数），否则部署接口报错
4. **COS 网关证书下发约 15 分钟才切 TLS**：`DeployCertificateInstance` 记录秒级显示 Success，但 `openssl s_client` 看到的还是 `*.cos.ap-guangzhou.myqcloud.com` 旧证书——**这不是失败**，等 10~15 分钟再验证，别误判重试
5. **Let's Encrypt 限速**：1 小时内 5 次失败授权会被限（429 + retry after 时间），调试时控制重试频率
6. **acme.sh v3.1.5 的 `dns_tencent` 插件环境变量是 `Tencent_SecretId/Tencent_SecretKey`**，新版才是 `TENCENTCLOUD_*`
7. api `.env` 里的 `COS_SECRET_ID/KEY` 在 DNSPod 报 `AuthFailure.SecretIdNotFound`（已失效或异账号），不能用于 DNS 验证；1Panel DNS 账号那对可用
8. **COS 源站域名的证书无公开 COS API**（`PUT Bucket domain` 不含证书字段），唯一 API 是 SSL 证书服务 `DeployCertificateInstance`；CDN 加速域名才走 `cdn UpdateDomainConfig`（本账号未开通 CDN）

## 日常运维

- **看续期是否正常**：`/root/.acme.sh/acme.sh --info -d static.buchuqin.com`（下次续期时间）；acme 日志 `/root/.acme.sh/acme.sh.log`
- **看推送是否正常**：手动跑 `python3 /opt/buchuqin/certs/push-static-cert.py` 应输出 push done；证书库（SSL 控制台）应只有一张 `auto-static.*` 别名证书
- **到期自检**：`curl -vI https://static.buchuqin.com` 看证书有效期是否始终在 90 天窗口内
- **存量 URL 未替换**：DB 中商品/分类图 URL 仍指向 `buchuqin-1462767498.cos.ap-guangzhou.myqcloud.com`；如需统一切到 static 域名，一次 UPDATE 即可（见 ADR-0003 的 URL 结构）
