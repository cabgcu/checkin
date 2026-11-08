// Public VIP sign-up forms — shared by index.html (admin) and register.html (public).
//
// Form settings live in the `secrets` table as one JSON row:
//   VIP_FORMS_CONFIG = { [eventId]: { [formType]: { status, opensAt, closesAt, title, intro, ... } },
//                        _global: { shirtSizes: [...], forms: { [formType]: { label, ... } } } }
// `_global` holds settings shared by every event: the shirt size list, renamed form
// labels, staff-created forms ({ custom: true, label, team, ticketedHost, guestLimit })
// and the email sender ({ email: { name, address, replyTo } }, see VIP_EMAIL_SENDER).
// Registrations are written to `guests` with the same team values the admin "Add
// Registration" screen uses, so the dashboard, ticket templates and check-in treat them
// exactly like manual entries.

const VIP_FORMS_KEY = 'VIP_FORMS_CONFIG';
const VIP_FORMS_GLOBAL_KEY = '_global';

const VIP_FORM_STAFF_DEPTS = ["Campus Health", "Campus Recreation", "Club Sports", "Community Standards", "Housing Operations", "Residence Life", "Spiritual Life", "Student Care", "Student Engagement", "Welcome Programs", "Other"];
const VIP_FORM_DEFAULT_SHIRT_SIZES = ["Small", "Medium", "Large", "X-Large", "XX-Large", "XXX-Large"];
const VIP_FORM_SHIRT_SIZES = [...VIP_FORM_DEFAULT_SHIRT_SIZES];   // filled from _global by vipFormsApplyGlobal

// ticketedHost: whether the main contact gets their own ticket. Acts / Special Events
// contacts are "label only" (email_sent = 'N/A'), matching the admin Add screen.
const VIP_FORM_BUILTIN_TYPES = {
    staff: {
        label: 'Staff Early Access',
        ticketedHost: true,
        teamFor: (dept) => dept || 'Staff Early Access',
        defaults: {
            title: 'Staff Early Access',
            intro: 'Sign up for early access as GCU staff. Each guest gets their own ticket by email before the event.',
            guestLimit: 3
        }
    },
    friends: {
        label: 'Friends of CAB Early Access',
        ticketedHost: true,
        teamFor: () => 'Friends of CAB Early Access',
        defaults: {
            title: 'Friends of CAB Early Access',
            intro: 'Sign up for Friends of CAB early access. Your ticket will be emailed to you before the event.',
            guestLimit: 0
        }
    },
    acts: {
        label: 'VIP Acts',
        ticketedHost: false,
        teamFor: () => 'VIP Acts',
        defaults: {
            title: 'VIP Acts Registration',
            intro: "Register your act's VIP guests. Each guest gets their own ticket by email before the event.",
            guestLimit: 10
        }
    },
    special: {
        label: 'VIP Special Events',
        ticketedHost: false,
        teamFor: () => 'Special Events',
        defaults: {
            title: 'VIP Special Events',
            intro: 'Register your VIP guests. Each guest gets their own ticket by email before the event.',
            guestLimit: 5
        }
    }
};

// Built-in forms plus any custom ones, with renamed labels applied. Rebuilt in place by
// vipFormsApplyGlobal so both pages can keep referring to the same object.
const VIP_FORM_TYPES = {};

function vipFormsGlobal(store) {
    return (store && store[VIP_FORMS_GLOBAL_KEY]) || {};
}

function vipFormsApplyGlobal(store) {
    const g = vipFormsGlobal(store);
    Object.keys(VIP_FORM_TYPES).forEach(k => delete VIP_FORM_TYPES[k]);
    Object.entries(VIP_FORM_BUILTIN_TYPES).forEach(([k, def]) => { VIP_FORM_TYPES[k] = { ...def }; });
    Object.entries(g.forms || {}).forEach(([k, o]) => {
        if (!o) return;
        if (VIP_FORM_TYPES[k]) {
            if (o.label) VIP_FORM_TYPES[k].label = o.label;
        } else if (o.custom && o.team) {
            const label = o.label || o.team;
            VIP_FORM_TYPES[k] = {
                label,
                custom: true,
                team: o.team,
                ticketedHost: o.ticketedHost !== false,
                teamFor: () => o.team,
                defaults: {
                    title: label,
                    intro: 'Sign up below. Each guest gets their own ticket by email before the event.',
                    guestLimit: Number.isFinite(o.guestLimit) ? o.guestLimit : 3
                }
            };
        }
    });
    const sizes = Array.isArray(g.shirtSizes) && g.shirtSizes.length ? g.shirtSizes : VIP_FORM_DEFAULT_SHIRT_SIZES;
    VIP_FORM_SHIRT_SIZES.splice(0, VIP_FORM_SHIRT_SIZES.length, ...sizes);
    vipEmailApplySender(g.email);
}

const VIP_FORM_COMMON_DEFAULTS = {
    status: 'closed',          // 'auto' (use opensAt/closesAt) | 'open' | 'closed'
    bannerUrl: '',             // form-specific banner; blank = use the event's email banner
    opensAt: '',               // ISO timestamps, used when status is 'auto'
    closesAt: '',
    askPhone: true,
    askShirt: false,
    allowEdits: true,          // registrants can edit their party after confirming name + email
    editsUntil: '',            // ISO timestamp; blank = until the event is deleted
    closedMessage: 'Registration is closed right now. Please reach out to the CAB Special Events team with any questions.',
    successMessage: "You're registered! We've emailed you a confirmation. To make changes later, come back to this page and choose \"Edit your registration\". Tickets are emailed to each guest before the event."
};

function vipFormConfig(store, eventId, type) {
    const def = VIP_FORM_TYPES[type];
    if (!def) return null;
    const saved = (store && store[eventId] && store[eventId][type]) || {};
    return { ...VIP_FORM_COMMON_DEFAULTS, ...def.defaults, ...saved };
}

// -> { open: boolean, reason: 'open' | 'closed' | 'not_yet' | 'ended' }
function vipFormState(cfg, now = new Date()) {
    if (!cfg) return { open: false, reason: 'closed' };
    if (cfg.status === 'open') return { open: true, reason: 'open' };
    if (cfg.status !== 'auto') return { open: false, reason: 'closed' };
    if (cfg.opensAt && now < new Date(cfg.opensAt)) return { open: false, reason: 'not_yet' };
    if (cfg.closesAt && now >= new Date(cfg.closesAt)) return { open: false, reason: 'ended' };
    return { open: true, reason: 'open' };
}

function vipFormCanEdit(cfg, now = new Date()) {
    if (!cfg || !cfg.allowEdits) return false;
    return !cfg.editsUntil || now < new Date(cfg.editsUntil);
}

// Which form a main-contact row came from, based on its team value.
function vipFormTypeForTeam(team) {
    if (!team) return null;
    if (team === 'VIP Acts') return 'acts';
    if (team === 'Special Events') return 'special';
    if (team === 'Friends of CAB Early Access') return 'friends';
    if (team === 'Staff Early Access' || VIP_FORM_STAFF_DEPTS.includes(team)) return 'staff';
    const custom = Object.entries(VIP_FORM_TYPES).find(([, def]) => def.custom && def.team === team);
    return custom ? custom[0] : null;
}

function vipFormLink(base, params) {
    const url = new URL('register.html', base);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    return url.toString();
}

// ── Email helpers shared by index.html, register.html and claim.html ─────────
// Messages are stored as plain text with **bold**, [link text](https://…),
// [button:Label](https://…) and {{VAR}} tokens.
const VIP_EMAIL_TEMPLATES_KEY = 'VIP_EMAIL_TEMPLATES_LIBRARY';
const VIP_EMAIL_URL = String.raw`(?:https?:\/\/|mailto:)[^\s)<>"]+`;
const VIP_EMAIL_BUTTON_RE = new RegExp(String.raw`\[button:\s*([^\]\n]+)\]\((${VIP_EMAIL_URL})\)`, 'gi');
const VIP_EMAIL_LINK_RE = new RegExp(String.raw`\[([^\]\n]+)\]\((${VIP_EMAIL_URL})\)`, 'g');

function vipEmailEscape(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function vipEmailButtonHtml(label, url) {
    return `<a href="${url}" target="_blank" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 26px;border-radius:9999px;font-family:sans-serif;">${label}</a>`;
}

// Fill {{VAR}} tokens; vars = { FIRST, LAST, EVENT, GROUP, COUNT, ... }. Unknown tokens are left as typed.
function vipFillVars(str, vars) {
    return String(str || '').replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (vars && vars[k] !== undefined && vars[k] !== null) ? String(vars[k]) : m);
}

// Stored message -> email HTML (escaped, so names and typed text can't break the layout)
function vipEmailBodyHtml(text) {
    let h = vipEmailEscape(text || '');
    h = h.replace(VIP_EMAIL_BUTTON_RE, (m, label, url) => vipEmailButtonHtml(label.trim(), url));
    h = h.replace(VIP_EMAIL_LINK_RE, (m, label, url) => `<a href="${url}" target="_blank" style="color:#2563eb;text-decoration:underline;">${label}</a>`);
    h = h.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
    return h.replace(/\n/g, '<br>');
}

// Stored message -> plain-text version of the email
function vipEmailBodyText(text) {
    return String(text || '')
        .replace(VIP_EMAIL_BUTTON_RE, (m, label, url) => `${label.trim()}: ${url}`)
        .replace(VIP_EMAIL_LINK_RE, (m, label, url) => label === url ? url : `${label} (${url})`)
        .replace(/\*\*(.*?)\*\*/g, '$1');
}

function vipEmailImageUrl(url) {
    if (!url) return "";
    if (url.includes('drive.google.com')) {
        const m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
        if (m && m[1]) return `https://lh3.googleusercontent.com/d/${m[1]}`;
    }
    return url;
}

// Who gets which template, per event (stored in the template library):
//   library[eventId].assign = { forms: { [formType]: { host, guests, confirm } }, live }
// Blank values mean "use the default".
function vipTemplateAssignment(library, eventId, formType) {
    const a = library && library[eventId] && library[eventId].assign;
    return (a && a.forms && a.forms[formType]) || {};
}

// Sign-up confirmation email (sent by register.html, previewed in index.html).
// tpl (optional): { subj, body } from the template library; without it the built-in wording is used.
function vipConfirmEmail({ eventName, formLabel, host, guests = [], canEdit, link, bannerUrl, tpl }) {
    const first = host.first_name || '', last = host.last_name || '';
    const vars = { FIRST: first, LAST: last, EVENT: eventName || '', GROUP: formLabel || '', COUNT: String(guests.length + 1) };
    const guestNames = guests.map(g => `${g.first_name || ''} ${g.last_name || ''}`.trim());
    const list = guestNames.length
        ? `<p style="margin:16px 0 6px;"><b>Your guests:</b></p><ul style="margin:0;padding-left:20px;">${guestNames.map(n => `<li>${vipEmailEscape(n)}</li>`).join('')}</ul>`
        : '';
    const editNote = canEdit ? `<p style="margin:16px 0 0;">Need to change something? Use the button below and confirm your first name, last name and this email address.</p>` : '';
    let subject, bodyHtml, text;
    if (tpl && (tpl.subj || tpl.body)) {
        const body = vipFillVars(tpl.body, vars);
        subject = vipFillVars(tpl.subj, vars) || `You're registered: ${eventName}`;
        bodyHtml = `<div>${vipEmailBodyHtml(body)}</div>${list}${editNote}`;
        text = vipEmailBodyText(body);
    } else {
        subject = `You're registered: ${eventName}`;
        bodyHtml = `<p style="margin:0 0 12px;">Hi ${vipEmailEscape(first)},</p>
            <p style="margin:0;">You're registered for <b>${vipEmailEscape(eventName)}</b> (${vipEmailEscape(formLabel)}).${guests.length ? ' Each guest will receive their own ticket by email before the event.' : ' Your ticket will be emailed to you before the event.'}</p>
            ${list}${editNote}`;
        text = `Hi ${first},\n\nYou're registered for ${eventName}.`;
    }
    if (guestNames.length) text += `\n\nYour guests:\n${guestNames.map(n => '- ' + n).join('\n')}`;
    text += `\n\nTo make changes, go to ${link} and confirm your name and email.`;
    const banner = vipEmailImageUrl(bannerUrl || '');
    const bannerRow = banner ? `<tr><td style="padding:0;"><img src="${vipEmailEscape(banner)}" width="500" style="display:block;width:100%;height:auto;border:0;" alt=""></td></tr>` : '';
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;"><tr><td align="center" style="padding:20px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:500px;background:#fff;border-radius:16px;overflow:hidden;">
            ${bannerRow}
            <tr><td align="center" style="padding:36px 24px 8px;"><h1 style="margin:0;font-size:22px;font-weight:800;color:#000;text-transform:uppercase;letter-spacing:1px;">You're registered</h1></td></tr>
            <tr><td style="padding:16px 30px 8px;font-size:16px;color:#000;line-height:1.6;">${bodyHtml}</td></tr>
            <tr><td align="center" style="padding:16px 30px 36px;"><a href="${vipEmailEscape(link)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:700;padding:14px 26px;border-radius:9999px;">${canEdit ? 'Edit your registration' : 'View registration page'}</a></td></tr>
            <tr><td align="center" style="padding:24px 20px;border-top:1px solid #f0f0f0;font-size:11px;font-weight:700;color:#bbb;text-transform:uppercase;letter-spacing:1px;">&copy; ${new Date().getFullYear()} Canyon Activities Board</td></tr>
        </table></td></tr></table></body></html>`;
    return { subject, html, text };
}

// ── Sender used by every email (Settings → Email Templates → Sender & delivery) ──
// The address must be a verified sender on a domain authenticated in Brevo (DKIM),
// or Brevo refuses the send / school mail filters junk it.
const VIP_EMAIL_DEFAULT_SENDER = { name: 'Canyon Activities Board', address: 'noreply@cabgcu.com', replyTo: '' };
const VIP_EMAIL_SENDER = { ...VIP_EMAIL_DEFAULT_SENDER };

function vipEmailApplySender(saved) {
    const o = saved || {};
    VIP_EMAIL_SENDER.name = (o.name || '').trim() || VIP_EMAIL_DEFAULT_SENDER.name;
    VIP_EMAIL_SENDER.address = (o.address || '').trim() || VIP_EMAIL_DEFAULT_SENDER.address;
    VIP_EMAIL_SENDER.replyTo = (o.replyTo || '').trim();
}

// Common Brevo payload fields: sender, reply-to and a tag (shows in Brevo → Logs, so you
// can see whether GCU accepted, deferred or blocked each email).
function vipBrevoBase(tag) {
    const base = { sender: { name: VIP_EMAIL_SENDER.name, email: VIP_EMAIL_SENDER.address } };
    if (VIP_EMAIL_SENDER.replyTo) base.replyTo = { email: VIP_EMAIL_SENDER.replyTo, name: VIP_EMAIL_SENDER.name };
    if (tag) base.tags = [tag];
    return base;
}

// Things that commonly push school email (Microsoft 365 / Outlook) into Junk.
// -> [{ level: 'warn' | 'tip', text }]
function vipEmailInboxChecks({ subject = '', text = '', html = '' }) {
    const out = [];
    const warn = t => out.push({ level: 'warn', text: t });
    const tip = t => out.push({ level: 'tip', text: t });
    const emoji = /\p{Extended_Pictographic}/gu;
    const subjEmoji = (subject.match(emoji) || []).length;
    const bodyEmoji = (text.match(emoji) || []).length;
    if (!subject.trim()) warn('The subject line is empty.');
    if (subjEmoji) warn(`The subject has ${subjEmoji === 1 ? 'an emoji' : subjEmoji + ' emoji'}. Emoji in subject lines are a common spam signal for school filters. Remove ${subjEmoji === 1 ? 'it' : 'them'}.`);
    if (bodyEmoji > 3) warn(`The message has ${bodyEmoji} emoji. Use 3 or fewer.`);
    if ((subject.match(/!/g) || []).length > 1) warn('The subject has more than one "!". Use one at most.');
    const capsWords = (subject.match(/\b[A-Z]{4,}\b/g) || []).filter(w => !['GCU', 'CAB', 'VIP', 'RSVP'].includes(w));
    if (capsWords.length) warn(`The subject has words in ALL CAPS (${capsWords.slice(0, 3).join(', ')}).`);
    if (/(!{2,}|\?{2,})/.test(text)) warn('The message has "!!" or "??". Use a single mark.');
    const words = /\b(free|act now|urgent|winner|congratulations|click here|limited time|guarantee[d]?|100%|\$\$|cash|prize|risk[- ]free)\b/gi;
    const hits = [...new Set(((subject + ' ' + text).match(words) || []).map(w => w.toLowerCase()))];
    if (hits.length) tip(`Words that spam filters weigh: "${hits.join('", "')}". They're fine once, but avoid them in the subject.`);
    if (/\b(bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|rb\.gy|cutt\.ly)\//i.test(text + html)) warn('A shortened link (bit.ly etc.) is a strong spam signal. Use the full address.');
    const links = (html.match(/<a\s[^>]*href=/gi) || []).length;
    if (links > 5) tip(`There are ${links} links. Fewer links look less like marketing.`);
    const wordCount = (text.match(/[A-Za-z]{2,}/g) || []).length;
    if (wordCount < 25) tip('The message is very short. A few sentences of real text (date, time, place) help it read as a personal email.');
    if (/^noreply@|^no-reply@/i.test(VIP_EMAIL_SENDER.address) && !VIP_EMAIL_SENDER.replyTo) tip('Emails come from a "noreply" address with no reply-to. Add a reply-to address under Sender & delivery so people can answer.');
    return out;
}

// Built-in forms, default shirt sizes and sender until a page loads the saved settings
vipFormsApplyGlobal({});
