const dns = require('dns').promises;
const net = require('net');
const SMTPConnection = require('smtp-connection');

const ROLE_BASED_PREFIXES = [
  'admin', 'info', 'support', 'sales', 'help', 'contact', 'team', 'office',
  'billing', 'finance', 'accounts', 'hr', 'career', 'jobs', 'no-reply', 'noreply'
];

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'yopmail.com', 'guerrillamail.com', 'sharklasers.com', 'getnada.com',
  'discardmail.com', 'trashmail.com', 'temporarily.de', 'tempmail.email', '10minutemail.com',
  'fakeinbox.com', 'moakt.com', 'mintemail.com', 'spamgourmet.com', 'maildrop.cc'
]);

const EMAIL_STATUS = {
  VERIFIED: 'verified',
  INVALID: 'invalid',
  RISKY: 'risky',
  DISPOSABLE: 'disposable'
};

const emailRegex =
  /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/;

const isSyntaxValid = (email) => emailRegex.test(email);

const isRoleBased = (localPart) => ROLE_BASED_PREFIXES.includes(localPart.toLowerCase());

const isDisposableDomain = (domain) => DISPOSABLE_DOMAINS.has(domain.toLowerCase());

async function resolveMx(domain) {
  try {
    const mx = await dns.resolveMx(domain);
    return mx.sort((a, b) => a.priority - b.priority);
  } catch (e) {
    return [];
  }
}

async function smtpRcpt(host, fromAddr, toAddr, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const conn = new SMTPConnection({
      host,
      port: 25,
      secure: false,
      tls: { rejectUnauthorized: false },
      socketTimeout: timeoutMs
    });
    let done = false;
    const finish = (res) => {
      if (!done) {
        done = true;
        try { conn.quit(); } catch (_) {}
        resolve(res);
      }
    };
    conn.on('error', () => finish({ ok: false, code: 0, reason: 'connect_error' }));
    conn.connect(() => {
      conn.send({ from: fromAddr, to: [toAddr] }, '', (err) => {
        if (err && err.responseCode) {
          const code = err.responseCode;
          if (code >= 500) finish({ ok: false, code, reason: 'hard_fail' });
          else finish({ ok: false, code, reason: 'soft_fail' });
          return;
        }
        if (err) {
          finish({ ok: false, code: 0, reason: 'send_error' });
          return;
        }
        finish({ ok: true, code: 250, reason: 'accepted' });
      });
    });
    setTimeout(() => finish({ ok: false, code: 0, reason: 'timeout' }), timeoutMs + 1000);
  });
}

async function verifyEmailSingle(email, options = {}) {
  const reasons = [];
  const safeSmtp = options.safeSmtp !== false;
  const localPart = email.split('@')[0] || '';
  const domain = email.split('@')[1] || '';

  if (!isSyntaxValid(email)) {
    reasons.push('syntax_invalid');
    return { email, status: EMAIL_STATUS.INVALID, reasons };
  }

  if (!domain) {
    reasons.push('domain_missing');
    return { email, status: EMAIL_STATUS.INVALID, reasons };
  }

  if (isDisposableDomain(domain)) {
    reasons.push('disposable_domain');
    return { email, status: EMAIL_STATUS.DISPOSABLE, reasons };
  }

  const role = isRoleBased(localPart);
  if (role) {
    reasons.push('role_based_address');
  }

  const mxRecords = await resolveMx(domain);
  if (mxRecords.length === 0) {
    reasons.push('mx_not_found');
    return { email, status: EMAIL_STATUS.INVALID, reasons };
  }

  if (!safeSmtp) {
    if (role) reasons.push('role_based_address');
    return { email, status: role ? EMAIL_STATUS.RISKY : EMAIL_STATUS.VERIFIED, reasons };
  }
  const probeFrom = process.env.SMTP_PROBE_FROM || process.env.EMAIL_USER_1 || `probe@${domain}`;
  const host = mxRecords[0].exchange;
  const randomUser = `noexist_${Date.now().toString(36)}`;
  const randomAddr = `${randomUser}@${domain}`;
  const catchAllRes = await smtpRcpt(host, probeFrom, randomAddr, Number(process.env.SMTP_VERIFY_TIMEOUT_MS || 8000));
  const targetRes = await smtpRcpt(host, probeFrom, email, Number(process.env.SMTP_VERIFY_TIMEOUT_MS || 8000));
  if (catchAllRes.ok) {
    reasons.push('catch_all');
  }
  if (targetRes.ok) {
    if (role) {
      reasons.push('role_based_address');
      return { email, status: EMAIL_STATUS.RISKY, reasons };
    }
    if (reasons.includes('catch_all')) {
      return { email, status: EMAIL_STATUS.RISKY, reasons };
    }
    return { email, status: EMAIL_STATUS.VERIFIED, reasons };
  }
  if (targetRes.code >= 500) {
    reasons.push('smtp_' + String(targetRes.code));
    return { email, status: EMAIL_STATUS.INVALID, reasons };
  }
  reasons.push(targetRes.reason || 'smtp_unknown');
  return { email, status: EMAIL_STATUS.RISKY, reasons };
}

async function verifyEmailsBatch(emails, options = {}) {
  const unique = Array.from(new Set(
    emails
      .map(e => (typeof e === 'string' ? e.trim() : e?.email?.trim()))
      .filter(Boolean)
  ));

  const concurrency = Number(process.env.VERIFY_CONCURRENCY || 20);
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < unique.length) {
      const i = idx++;
      const email = unique[i];
      try {
        const res = await verifyEmailSingle(email, options);
        results.push(res);
      } catch (e) {
        results.push({ email, status: EMAIL_STATUS.RISKY, reasons: ['verification_error'] });
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, unique.length) }, () => worker());
  await Promise.all(workers);

  const counts = results.reduce((acc, r) => {
    acc.total++;
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, { total: 0, verified: 0, invalid: 0, risky: 0, disposable: 0 });

  const verified = results.filter(r => r.status === EMAIL_STATUS.VERIFIED).map(r => r.email);
  const rejected = results.filter(r => r.status !== EMAIL_STATUS.VERIFIED);

  return { counts, results, verified, rejected };
}

module.exports = {
  verifyEmailsBatch,
  EMAIL_STATUS
};
