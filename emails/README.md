# /emails

Two transactional templates. Both are self-contained HTML with inline styles
(so email clients don't strip them), one CTA, one link fallback, and no
external CSS, image, or script.

- `magic-link.html` — sent by Supabase Auth's **Magic Link** template when an
  existing account asks for a sign-in link (from `/portal` and from
  `invite-member` for addresses that already have an account).
  Subject: **Your Ghostwriter Mom sign-in**

- `invite.html` — sent by Supabase Auth's **Invite user** template when
  `admin.auth.admin.inviteUserByEmail()` runs for a new address (the portal
  invite pop-up).
  Subject: **You're invited to your content portal**

Both templates use Supabase's default token `{{ .ConfirmationURL }}` for the
one-time link. No other tokens needed.

## Where to paste them

Supabase Studio → Auth → Email Templates. Two entries:

1. **Magic Link** → subject = "Your Ghostwriter Mom sign-in", body = contents
   of `magic-link.html`.
2. **Invite user** → subject = "You're invited to your content portal", body
   = contents of `invite.html`.

Do not touch **Confirm signup** or **Change email**; the portal uses neither.

## Design notes

- Paper background `#F4F1EA` with a warm ivory card `#FDFAF2`.
- Body copy: Inter (with a system-font fallback list).
- Headline: Palatino italic, no negative letter-spacing (email clients tend to
  swallow it and re-space every glyph).
- CTA: `#B8FF71` lime with a black hairline border. Radius 10.
- Max card width 520px. Copy sits in a 40px inset. Fully responsive because
  the outer table is width 100% and the inner table has max-width 520.
- No em dashes.

## Sending mechanics

Supabase Auth delivers both emails on its own (using the SMTP endpoint you've
configured — Resend, in production). `invite-member` does NOT send email
itself; it calls `inviteUserByEmail` or `signInWithOtp`, and Auth sends.
