import pg from 'pg';

// Keep int8 lossless. Business/API boundaries must explicitly check safe-number ranges.
export const postgresTypes = {
  getTypeParser(oid, format) {
    return oid === 20 && format !== 'binary' ? value => BigInt(value) : pg.types.getTypeParser(oid, format);
  }
};

// No environment-variable fallback: opening a connection is an explicit caller decision.
export function openPostgres({ connectionString, ssl, max = 5 } = {}) {
  if (!connectionString) throw new Error('需要显式提供 PostgreSQL 连接配置');
  const pool = new pg.Pool({ connectionString, ssl, max, connectionTimeoutMillis:10000, statement_timeout:30000, types: postgresTypes });
  return pool;
}

// A whole transaction owns one connection; never use pool.query between BEGIN and COMMIT.
// No automatic retries: callbacks may have external side effects.
export async function postgresTransaction(pool, fn) {
  const client = await pool.connect();
  let begun = false, discard;
  try {
    await client.query('BEGIN');
    begun = true;
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    if (begun) {
      try { await client.query('ROLLBACK'); }
      catch { discard = new Error('事务回滚失败，丢弃连接'); }
    } else discard = new Error('事务初始化失败，丢弃连接');
    throw error;
  } finally {
    client.release(discard);
  }
}

export function safeInteger(value) {
  const number = Number(value);
  if ((typeof value !== 'bigint' && typeof value !== 'number') || !Number.isSafeInteger(number))
    throw new Error('数据库整数超出业务安全范围');
  return number;
}
