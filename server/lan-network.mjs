import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

function normalizeClientAddress(address) {
  return typeof address === 'string' && address.startsWith('::ffff:') ? address.slice(7) : address;
}
function ipv4Number(address) {
  return address.split('.').reduce((value, part) => (value * 256 + Number(part)) >>> 0, 0);
}
export function isPrivateIPv4(address) {
  if (isIP(address ?? '') !== 4) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 10 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168;
}
export function validateLanNetwork(address, prefixLength) {
  if (!isPrivateIPv4(address)) throw new Error('LAN 地址必须为明确的私有 IPv4，不能使用公网、回环或通配地址');
  if (!Number.isInteger(prefixLength) || prefixLength < 1 || prefixLength > 32)
    throw new Error('LAN 子网前缀长度必须为 1 至 32 的整数');
  return { address, prefixLength };
}
export function isAddressInSubnet(clientAddress, address, prefixLength) {
  const client = normalizeClientAddress(clientAddress);
  if (!isPrivateIPv4(client) || !isPrivateIPv4(address) || !Number.isInteger(prefixLength) || prefixLength < 1 || prefixLength > 32) return false;
  const mask = (0xffffffff << (32 - prefixLength)) >>> 0;
  return (ipv4Number(client) & mask) === (ipv4Number(address) & mask);
}
export function isLocalLanClient(clientAddress, address) {
  const client = normalizeClientAddress(clientAddress);
  return client === address || client === '::1' || isIP(client ?? '') === 4 && client.startsWith('127.');
}
export function isAllowedLanClient(clientAddress, network) {
  return isLocalLanClient(clientAddress, network.address)
    || isAddressInSubnet(clientAddress, network.address, network.prefixLength);
}
function prefixFromNetmask(netmask) {
  if (isIP(netmask ?? '') !== 4) return null;
  const bits = ipv4Number(netmask).toString(2).padStart(32, '0');
  return /^1*0*$/.test(bits) ? bits.indexOf('0') === -1 ? 32 : bits.indexOf('0') : null;
}
export function validateLanBinding(address, prefixLength, interfaces = networkInterfaces()) {
  const network = validateLanNetwork(address, prefixLength);
  const actual = Object.values(interfaces).flatMap(items => items ?? []).find(item =>
    (item.family === 'IPv4' || item.family === 4) && item.internal === false && item.address === address);
  if (!actual) throw new Error('LAN 地址未绑定到当前电脑的 IPv4 网卡，请重新选择实际网卡地址');
  if (prefixFromNetmask(actual.netmask) !== prefixLength)
    throw new Error('LAN 前缀长度与当前网卡不一致，不能扩大或猜测子网范围');
  return network;
}
