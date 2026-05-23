import crypto from 'crypto';

const API_BASE = 'https://api.ifdian.net/api/open';

function md5(s: string): string {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

function sign(token: string, params: string, ts: number, userId: string): string {
  return md5(`${token}params${params}ts${ts}user_id${userId}`);
}

export interface AifadianQueryResult {
  out_trade_no: string;
  custom_order_id: string;
  user_id: string;
  plan_id: string;
  total_amount: string;
  status: number; // 2 = paid
  remark: string;
  pay_time?: number;
}

export async function queryOrder(
  outTradeNo: string,
  userId: string,
  token: string,
): Promise<{ ec: number; order?: AifadianQueryResult; error?: string }> {
  const params = JSON.stringify({ out_trade_no: outTradeNo });
  const ts = Math.floor(Date.now() / 1000);
  const signStr = sign(token, params, ts, userId);

  const body = { user_id: userId, params, ts, sign: signStr };

  try {
    const resp = await fetch(`${API_BASE}/query-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json();
    if (data.ec !== 200) {
      return { ec: data.ec, error: data.em || 'query failed' };
    }
    const list: AifadianQueryResult[] = data.data?.list || [];
    const order = list.find((o) => o.out_trade_no === outTradeNo);
    return { ec: 200, order };
  } catch (e: any) {
    return { ec: -1, error: e.message || String(e) };
  }
}
