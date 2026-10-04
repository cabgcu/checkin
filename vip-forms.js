// Public VIP sign-up forms — shared by index.html (admin) and register.html (public).
//
// Form settings live in the `secrets` table as one JSON row:
//   VIP_FORMS_CONFIG = { [eventId]: { [formType]: { status, opensAt, closesAt, title, intro, ... } } }
// Registrations are written to `guests` with the same team values the admin "Add
// Registration" screen uses, so the dashboard, ticket templates and check-in treat them
// exactly like manual entries.

const VIP_FORMS_KEY = 'VIP_FORMS_CONFIG';

const VIP_FORM_STAFF_DEPTS = ["Campus Health", "Campus Recreation", "Club Sports", "Community Standards", "Housing Operations", "Residence Life", "Spiritual Life", "Student Care", "Student Engagement", "Welcome Programs", "Other"];
const VIP_FORM_SHIRT_SIZES = ["Small", "Medium", "Large", "X-Large", "XX-Large", "XXX-Large"];

// ticketedHost: whether the main contact gets their own ticket. Acts / Special Events
// contacts are "label only" (email_sent = 'N/A'), matching the admin Add screen.
const VIP_FORM_TYPES = {
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

const VIP_FORM_COMMON_DEFAULTS = {
    status: 'closed',          // 'auto' (use opensAt/closesAt) | 'open' | 'closed'
    bannerUrl: '',             // form-specific banner; blank = use the event's email banner
    opensAt: '',               // ISO timestamps, used when status is 'auto'
    closesAt: '',
    askPhone: true,
    askShirt: false,
    allowEdits: true,          // registrants can edit their party with their private link
    editsUntil: '',            // ISO timestamp; blank = until the event is deleted
    closedMessage: 'Registration is closed right now. Please reach out to the CAB Special Events team with any questions.',
    successMessage: "You're registered! We've emailed you a link to view or edit your registration. Tickets are emailed to each guest before the event."
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
    return null;
}

function vipFormLink(base, params) {
    const url = new URL('register.html', base);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    return url.toString();
}
