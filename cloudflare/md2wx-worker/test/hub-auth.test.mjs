/** hub-auth 单元测试：直接 import 源码（纯 Web Crypto，无需打包） */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken } from '../hub-auth.js';

describe('hub-auth token', () => {
  const PW = 's3cret-密码';

  it('签发的 token 可被同密码校验通过', async () => {
    const token = await signToken(PW, 1_000_000);
    assert.equal(await verifyToken(token, PW, 1_000_000 + 1000), true);
  });

  it('错误密码校验失败', async () => {
    const token = await signToken(PW);
    assert.equal(await verifyToken(token, 'wrong'), false);
  });

  it('过期 token 校验失败（7 天有效期）', async () => {
    const now = 1_000_000;
    const token = await signToken(PW, now);
    const aWeekLater = now + 7 * 24 * 3600 * 1000 + 1;
    assert.equal(await verifyToken(token, PW, aWeekLater), false);
  });

  it('篡改 payload 或签名均失败', async () => {
    const token = await signToken(PW);
    const [p, s] = token.split('.');
    assert.equal(await verifyToken(p + 'x.' + s, PW), false);
    assert.equal(await verifyToken(p + '.' + s.slice(0, -2) + 'xx', PW), false);
  });

  it('非字符串/缺点的 token 返回 false 而非抛错', async () => {
    assert.equal(await verifyToken(null, PW), false);
    assert.equal(await verifyToken(123, PW), false);
    assert.equal(await verifyToken('nodot', PW), false);
  });
});
