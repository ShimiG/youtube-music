// Which addresses the server may contact when the address comes from a person
// (a cover image URL, the cloud service's address) rather than from the code.
//
// A server that fetches whatever address it is given can be pointed at this
// computer, at the home or office network behind it, or at a cloud provider's
// metadata address (server-side request forgery). Everything here answers one
// question: is this an ordinary address on the public internet?
//
// Used by services/artworkColors.js and services/cloud/client.js. The check
// that matters is guardedLookup(): it is given to the socket, so the address
// that was checked is the address that is connected to. Checking a name first
// and connecting afterwards leaves a gap in which the name can change.
const net = require('net');

const blocked = new net.BlockList();
for (const [prefix, bits] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) blocked.addSubnet(prefix, bits, 'ipv4');
for (const [prefix, bits] of [
    ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
    ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
]) blocked.addSubnet(prefix, bits, 'ipv6');
// IPv4 written as IPv6 (::ffff:127.0.0.1) is never a real host. Kept apart:
// in the list above this rule would also match every plain IPv4 address.
const mapped = new net.BlockList();
mapped.addSubnet('::ffff:0:0', 96, 'ipv6');

/** Whether an IP address is an ordinary public one. */
function isPublicAddress(address) {
    const family = net.isIP(address);
    if (family === 4) return !blocked.check(address, 'ipv4');
    if (family === 6) return !mapped.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
    return false;
}

/** A URL's host as written, without the brackets around an IPv6 address. */
const hostOf = (url) => String(url.hostname || '').replace(/^\[|\]$/g, '');

/**
 * Whether a URL names a place that is plainly not on the public internet,
 * judged from the text alone: an address written out that is private, or
 * "localhost". A name that only resolves to a private address is not caught
 * here; that is guardedLookup's job, at connection time.
 */
function namesPrivateHost(url) {
    const host = hostOf(url).toLowerCase();
    if (net.isIP(host)) return !isPublicAddress(host);
    return host === 'localhost' || host.endsWith('.localhost');
}

/**
 * A dns.lookup for a socket that refuses a host with any non-public address.
 * `lookup` does the resolving (dns.lookup, or a test's stand-in) and
 * `blockedError` makes the error to fail with.
 */
function guardedLookup({ lookup, blockedError }) {
    return (hostname, options, callback) => {
        const done = typeof options === 'function' ? options : callback;
        const opts = typeof options === 'function' ? {} : (options || {});
        lookup(hostname, { ...opts, all: true }, (err, addresses) => {
            if (err) return done(err);
            const list = Array.isArray(addresses) ? addresses : [];
            if (!list.length || !list.every((entry) => isPublicAddress(entry.address))) return done(blockedError());
            return opts.all ? done(null, list) : done(null, list[0].address, list[0].family);
        });
    };
}

module.exports = { isPublicAddress, namesPrivateHost, guardedLookup, hostOf };
