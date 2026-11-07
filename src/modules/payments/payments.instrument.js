'use strict';

// Extracts the NON-SENSITIVE payment instrument summary from a Razorpay payment entity (fetch response or
// webhook entity). Only display metadata is kept: card network / last 4 / type / issuer, bank code, wallet
// name and a masked UPI handle. PAN, CVV, expiry, OTP, email, contact and the full VPA are never read.

const EMPTY = Object.freeze({
  cardNetwork: null, cardLast4: null, cardType: null, cardIssuer: null,
  bankCode: null, walletName: null, upiHandleMasked: null,
});

const text = (v, max) => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
};
const code = (v, max) => {
  const s = text(v, max);
  return s ? s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || null : null;
};

// "alice@okhdfc" -> "al***@okhdfc"; never returns the full handle.
const maskVpa = (vpa) => {
  if (typeof vpa !== 'string') return null;
  const at = vpa.indexOf('@');
  if (at < 1 || at === vpa.length - 1) return null;
  const provider = vpa.slice(at + 1).trim().slice(0, 40);
  return provider ? `${vpa.slice(0, Math.min(2, at))}***@${provider}` : null;
};

const extractInstrument = (entity) => {
  if (!entity || typeof entity !== 'object') return { ...EMPTY };
  const out = { ...EMPTY };
  switch (entity.method) {
    case 'card': {
      const c = entity.card && typeof entity.card === 'object' ? entity.card : {};
      out.cardNetwork = code(c.network, 30);
      out.cardLast4 = typeof c.last4 === 'string' && /^\d{4}$/.test(c.last4) ? c.last4 : null;
      const type = code(c.type, 10);
      out.cardType = ['CREDIT', 'DEBIT', 'PREPAID'].includes(type) ? type : null;
      out.cardIssuer = code(c.issuer, 50);
      break;
    }
    case 'netbanking': out.bankCode = code(entity.bank, 30); break;
    case 'wallet': out.walletName = code(entity.wallet, 30); break;
    case 'upi': out.upiHandleMasked = maskVpa(entity.vpa); break;
    default: break;
  }
  return out;
};

module.exports = { extractInstrument, maskVpa, EMPTY };
