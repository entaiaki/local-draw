import crypto from 'crypto';

const API_BASE = 'https://ifdian.net/api/open';

function md5(s: string): string {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

function sign(token: string, params: string, ts: number, userId: string): string {
  return md5(`${token}params${params}ts${ts}user_id${userId}`);
}

export interface AifadianSku {
  sku_id: string;
  count: number;
  price?: string;
  floor_price?: string;
  name?: string;
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
  sku_detail?: AifadianSku[];
}

async function callApi(paramsObj: Record<string, any>, userId: string, token: string): Promise<any> {
  const params = JSON.stringify(paramsObj);
  const ts = Math.floor(Date.now() / 1000);
  const signStr = sign(token, params, ts, userId);

  const url = `${API_BASE}/query-order`;
  const body = JSON.stringify({ user_id: userId, params, ts, sign: signStr });
  console.log(`[aifadian] POST ${url} ts=${ts} sign=${signStr.slice(0,8)}...`);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json();
    console.log(`[aifadian] response ec=${data.ec} list=${data.data?.list?.length || 0}`);
    return data;
  } catch (e: any) {
    console.log(`[aifadian] fetch error: ${e.message}`);
    throw e;
  }
}

export async function queryOrder(
  outTradeNo: string,
  userId: string,
  token: string,
): Promise<{ ec: number; order?: AifadianQueryResult; error?: string }> {
  try {
    const data = await callApi({ out_trade_no: outTradeNo }, userId, token);
    if (data.ec !== 200) return { ec: data.ec, error: data.em || 'query failed' };
    const list: AifadianQueryResult[] = data.data?.list || [];
    return { ec: 200, order: list.find((o) => o.out_trade_no === outTradeNo) };
  } catch (e: any) {
    return { ec: -1, error: e.message || String(e) };
  }
}

// 按 custom_order_id 或 remark（论坛用户ID）查询最近已支付的订单
export async function queryPaidByRemark(
  customId: string,
  userId: string,
  token: string,
): Promise<{ ec: number; orders: AifadianQueryResult[]; error?: string }> {
  try {
    const data = await callApi({ page: 1, per_page: 100 }, userId, token);
    if (data.ec !== 200) return { ec: data.ec, error: data.em || 'query failed' };
    const list: AifadianQueryResult[] = data.data?.list || [];
    return {
      ec: 200,
      orders: list.filter(
        (o) => o.status === 2 && (o.custom_order_id === customId || o.remark === customId),
      ),
    };
  } catch (e: any) {
    return { ec: -1, error: e.message || String(e) };
  }
}
