/** NestJS 标配 jest 配置（2026-10-13 补）：
 *  - ts-jest 转换：仓里一直装着 ts-jest 但无 config，默认 babel-jest 无 TS
 *    预设，`import type` 等语法解析必炸（此前靠陈旧转换缓存侥幸跑过）；
 *  - testTimeout 20s：测试库在测试服务器（道哥 2026-10-13 定），远程延迟
 *    下全链路用例超默认 5s 假挂。 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testTimeout: 20000,
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  setupFiles: ['<rootDir>/test-database-guard.ts'],
  testRegex: '.*\\.spec\\.ts$',
};
