import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';

/**
 * 429 友好化（IKFQM9）：ThrottlerException 的默认 message 是英文
 * 「ThrottlerException: Too Many Requests」，直接透传到 admin toast / 小程序
 * toast 用户看不懂。这里精准捕获该异常（@Catch 单类型，其他异常仍走 Nest
 * 默认过滤器，零侵入），转成中文文案。限流窗口恒 60s，文案写死「一分钟」，
 * 不读 Retry-After 动态秒数。前端 request() 读 body.message 自动显示。
 */
@Catch(ThrottlerException)
export class ThrottlerExceptionFilter implements ExceptionFilter {
  catch(exception: ThrottlerException, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse();
    res.status(HttpStatus.TOO_MANY_REQUESTS).json({
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      message: '操作太频繁，请稍等一分钟后再试',
    });
  }
}
