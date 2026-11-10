/*
 * Twilio click-to-call bridge (same flow as the Node version):
 *   1. Ring the HR's own mobile.
 *   2. When they answer, Twilio fetches TwiML which dials the candidate.
 */

export function twilioConfig(env) {
  const accountSid = env.TWILIO_ACCOUNT_SID || '';
  const authToken = env.TWILIO_AUTH_TOKEN || '';
  const fromNumber = env.TWILIO_FROM_NUMBER || '';
  return { accountSid, authToken, fromNumber, enabled: Boolean(accountSid && authToken && fromNumber) };
}

export async function placeBridgedCall(env, baseUrl, { hrMobile, contactPhone }) {
  const cfg = twilioConfig(env);
  if (!cfg.enabled) {
    return {
      ok: true,
      mock: true,
      sid: `DEMO-${Date.now()}`,
      message: 'Demo mode: no real call placed. Add Twilio secrets to actually ring the phone.',
    };
  }

  const twimlUrl = `${baseUrl}/api/voice/twiml?to=${encodeURIComponent(contactPhone)}`;
  const body = new URLSearchParams({
    To: hrMobile,
    From: cfg.fromNumber,
    Url: twimlUrl,
    Timeout: '25',
    StatusCallback: `${baseUrl}/api/voice/status`,
    StatusCallbackMethod: 'POST',
  });

  const auth = btoa(`${cfg.accountSid}:${cfg.authToken}`);
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Calls.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    },
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: data.message || `Twilio error (HTTP ${res.status})` };
  }
  return { ok: true, mock: false, sid: data.sid };
}

/** TwiML Twilio fetches the moment the HR picks up their mobile. */
export function twimlFor(env, contactPhone) {
  const safe = String(contactPhone || '').replace(/[^+0-9]/g, '');
  const callerId = String(env.TWILIO_FROM_NUMBER || '').replace(/[^+0-9]/g, '');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting your call.</Say>
  <Dial callerId="${callerId}" timeout="30">${safe}</Dial>
</Response>`;
}
