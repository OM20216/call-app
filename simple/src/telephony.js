import { config, twilioEnabled } from './config.js';

/*
 * Click-to-call bridge:
 *   1. We ask the phone network (Twilio) to ring the HR's own mobile.
 *   2. When the HR answers, Twilio reads the TwiML below, which dials the
 *      contact and joins the two calls together.
 * Without Twilio credentials we run in demo mode: the count still goes up,
 * but no real phone rings.
 */

export async function placeBridgedCall({ hrMobile, contactPhone }) {
  if (!twilioEnabled) {
    return {
      ok: true,
      mock: true,
      sid: `DEMO-${Date.now()}`,
      message: 'Demo mode: no real call placed. Add Twilio credentials in .env to actually ring the phone.',
    };
  }

  const twimlUrl =
    `${config.publicBaseUrl}/api/voice/twiml?to=` + encodeURIComponent(contactPhone);

  const body = new URLSearchParams({
    To: hrMobile,
    From: config.twilio.fromNumber,
    Url: twimlUrl,
    Timeout: '25',
    StatusCallback: `${config.publicBaseUrl}/api/voice/status`,
    StatusCallbackMethod: 'POST',
  });

  const auth = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64');
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Calls.json`,
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
export function twimlFor(contactPhone) {
  const safe = String(contactPhone || '').replace(/[^+0-9]/g, '');
  const callerId = config.twilio.fromNumber;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting your call.</Say>
  <Dial callerId="${callerId}" timeout="30">${safe}</Dial>
</Response>`;
}
