function chineseDateTime(value) {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间待核对';
  const pad = number => String(number).padStart(2, '0');
  // Use the same device-local time as the previous toLocaleString display.
  return date.getFullYear() + '年' + pad(date.getMonth() + 1) + '月' + pad(date.getDate()) + '日 ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}
module.exports = { chineseDateTime };
