import {describe, expect, it} from 'bun:test'
import {isGloballyReachable, parseIp, parseIpv4, parseIpv6} from './ip-classify'

describe('parseIpv4', () => {
  it('parses dotted quads', () => {
    expect(parseIpv4('8.8.8.8')).toBe(0x08_08_08_08n)
    expect(parseIpv4('0.0.0.0')).toBe(0n)
    expect(parseIpv4('255.255.255.255')).toBe(0xff_ff_ff_ffn)
  })

  it.each([
    '1.2.3',
    '1.2.3.4.5',
    '256.1.1.1',
    '01.2.3.4',
    '1.2.3.04',
    '1.2.3.',
    '.1.2.3',
    '1..2.3',
    'a.b.c.d',
    '1.2.3.4/8',
  ])('rejects %s', text => {
    expect(parseIpv4(text)).toBeUndefined()
  })
})

describe('parseIpv6', () => {
  it('parses full, compressed and embedded-IPv4 forms', () => {
    expect(parseIpv6('::')).toBe(0n)
    expect(parseIpv6('::1')).toBe(1n)
    expect(parseIpv6('0:0:0:0:0:0:0:1')).toBe(1n)
    expect(parseIpv6('2606:4700::1')).toBe((0x2606n << 112n) | (0x4700n << 96n) | 1n)
    expect(parseIpv6('::ffff:8.8.8.8')).toBe((0xff_ffn << 32n) | 0x08_08_08_08n)
    expect(parseIpv6('::1.2.3.4')).toBe(0x01_02_03_04n)
    expect(parseIpv6('64:ff9b::1.2.3.4')).toBe((0x64n << 112n) | (0xff9bn << 96n) | 0x01_02_03_04n)
  })

  it.each([
    '1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:8:9',
    '1::2::3',
    ':1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:',
    '12345::1',
    'g::1',
    'fe80::1%eth0',
    '1:2:3:4:5:6:7::8',
    '::1.2.3',
    '::1.2.3.256',
    '12:30:45',
    'aa:bb:cc:dd:ee:ff',
    ':::',
    '',
  ])('rejects %p', text => {
    expect(parseIpv6(text)).toBeUndefined()
  })
})

describe('parseIp', () => {
  it('reports the address family, or nothing for non-IPs', () => {
    expect(parseIp('1.2.3.4')?.version).toBe(4)
    expect(parseIp('::1')?.version).toBe(6)
    expect(parseIp('host.example.com')).toBeUndefined()
    expect(parseIp('1.2.3')).toBeUndefined()
  })
})

describe('isGloballyReachable: IPv4', () => {
  it.each(['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '192.88.99.1'])(
    '%s is globally reachable',
    ip => {
      expect(isGloballyReachable(ip)).toBe(true)
    },
  )

  it.each([
    '10.116.0.3',
    '10.0.0.0',
    '172.28.0.2',
    '172.16.0.1',
    '172.31.255.255',
    '127.0.0.1',
    '127.255.255.254',
    '0.0.0.0',
    '0.1.2.3',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '100.127.255.255',
    '192.0.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.7',
    '203.0.113.5',
    '224.0.0.251',
    '240.0.0.1',
    '255.255.255.255',
  ])('%s is not globally reachable', ip => {
    expect(isGloballyReachable(ip)).toBe(false)
  })

  it('lets a more specific globally reachable entry override its covering block', () => {
    expect(isGloballyReachable('192.0.0.9')).toBe(true)
    expect(isGloballyReachable('192.0.0.10')).toBe(true)
    expect(isGloballyReachable('192.0.0.11')).toBe(false)
    expect(isGloballyReachable('192.31.196.1')).toBe(true)
    expect(isGloballyReachable('192.88.99.2')).toBe(false)
  })
})

describe('isGloballyReachable: IPv6', () => {
  it.each([
    '2606:4700::1',
    '2001:4860:4860::8888',
    '2a00:1450:4001::',
    '2001:20::1',
    '2002:808:808::1',
    '64:ff9b::808:808',
  ])('%s is globally reachable', ip => {
    expect(isGloballyReachable(ip)).toBe(true)
  })

  it.each([
    'fd00::1',
    'fc00::1',
    'fe80::1',
    '::1',
    '::',
    '2001:db8::1',
    '2001:2::1',
    '3fff::1',
    '3fff:fff::1',
    '5f00::1',
    'ff02::1',
    '100::1',
    '64:ff9b:1::1',
    'a::b',
    'dead:beef::1',
    '4000::1',
  ])('%s is not globally reachable', ip => {
    expect(isGloballyReachable(ip)).toBe(false)
  })

  it('unwraps IPv4-mapped addresses before classifying', () => {
    expect(isGloballyReachable('::ffff:8.8.8.8')).toBe(true)
    expect(isGloballyReachable('::ffff:10.0.0.1')).toBe(false)
    expect(isGloballyReachable('::ffff:808:808')).toBe(true)
    expect(isGloballyReachable('::ffff:7f00:1')).toBe(false)
    expect(isGloballyReachable('::ffff:192.0.2.1')).toBe(false)
  })
})

describe('isGloballyReachable: non-IPs', () => {
  it.each(['example.com', '1.2.3', 'v1.2.3', '', 'deadbeef'])('returns undefined for %p', text => {
    expect(isGloballyReachable(text)).toBeUndefined()
  })
})
