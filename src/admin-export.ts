type AdminSession = {user: {id: string; role: string} | null};

// Export bytes stay in memory until both the page and administrator are current.
export async function prepareAdminExport<T>(userId: string, active: () => boolean,
  session: () => Promise<AdminSession>, build: () => Promise<T>): Promise<T | undefined> {
  async function current() {
    if (!active()) return false;
    const value = await session();
    if (!active()) return false;
    if (value.user?.id !== userId || value.user.role !== 'admin')
      throw new Error('登录账号已变化，导出已取消，请重新打开管理后台。');
    return true;
  }
  if (!await current()) return;
  const output = await build();
  if (!await current()) return;
  return output;
}
