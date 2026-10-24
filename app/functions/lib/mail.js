// Email through Resend (https://resend.com/docs/api-reference/emails/send-email).
// RESEND_API overrides the address for the offline test. A key of "none"
// (what app/setup.sh deploy stores until `app/setup.sh email`) sends nothing.
const api = () => process.env.RESEND_API || 'https://api.resend.com';

export async function sendMail({ key, from, to, subject, html, text }) {
  const list = [...new Set((to || []).filter(Boolean))];
  if (!key || key === 'none') return { skipped: 'email is off (no Resend key; run app/setup.sh email)' };
  if (!list.length) return { skipped: 'no recipients' };
  const r = await fetch(`${api()}/emails`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: list, subject, html, text }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return { id: (await r.json()).id, count: list.length };
}
