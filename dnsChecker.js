const dns = require('dns').promises;

/**
 * Checks SPF, DKIM, and DMARC records for a given domain.
 * @param {string} domain - The domain to check (e.g., 'gmail.com').
 * @param {string} [selector] - The DKIM selector (optional).
 * @returns {Promise<Object>} - The results of the DNS checks.
 */
const checkDomainSecurity = async (domain, selector = 'default') => {
  const results = {
    domain,
    spf: { valid: false, record: null, error: null },
    dmarc: { valid: false, record: null, error: null },
    dkim: { valid: false, record: null, error: null }, // Hard to check without selector, but we can try common ones or skip
    mx: { valid: false, records: [], error: null }
  };

  try {
    // 1. Check MX Records
    try {
      const mxRecords = await dns.resolveMx(domain);
      results.mx.valid = mxRecords && mxRecords.length > 0;
      results.mx.records = mxRecords;
    } catch (err) {
      results.mx.error = err.message;
    }

    // 2. Check SPF (TXT record starting with v=spf1)
    try {
      const txtRecords = await dns.resolveTxt(domain);
      const spfRecord = txtRecords.flat().find(r => r.includes('v=spf1'));
      if (spfRecord) {
        results.spf.valid = true;
        results.spf.record = spfRecord;
      } else {
        results.spf.error = 'No SPF record found';
      }
    } catch (err) {
      results.spf.error = err.message;
    }

    // 3. Check DMARC (TXT record at _dmarc.domain)
    try {
      const dmarcRecords = await dns.resolveTxt(`_dmarc.${domain}`);
      const dmarcRecord = dmarcRecords.flat().find(r => r.includes('v=DMARC1'));
      if (dmarcRecord) {
        results.dmarc.valid = true;
        results.dmarc.record = dmarcRecord;
      } else {
        results.dmarc.error = 'No DMARC record found';
      }
    } catch (err) {
      if (err.code === 'ENOTFOUND') {
        results.dmarc.error = 'No _dmarc record found';
      } else {
        results.dmarc.error = err.message;
      }
    }

    // 4. Check DKIM (TXT record at selector._domainkey.domain)
    // This is tricky because we need the selector. We'll skip if not provided or try 'google'/'default'
    if (selector) {
      try {
        const dkimRecords = await dns.resolveTxt(`${selector}._domainkey.${domain}`);
        const dkimRecord = dkimRecords.flat().find(r => r.includes('v=DKIM1') || r.includes('k=rsa'));
        if (dkimRecord) {
          results.dkim.valid = true;
          results.dkim.record = dkimRecord;
        }
      } catch (err) {
        // DKIM fail is expected if selector is wrong
        results.dkim.error = `Could not find DKIM for selector '${selector}'`;
      }
    }

  } catch (error) {
    console.error('DNS Check Error:', error);
  }

  return results;
};

module.exports = { checkDomainSecurity };
