import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRightIcon as ArrowRight,
  CalendarBlankIcon as Calendar,
  CheckIcon as Check,
  CircleNotchIcon as Loader2,
  EnvelopeSimpleIcon as Mail,
  MapPinIcon as MapPin,
  PhoneIcon as Phone,
} from "@phosphor-icons/react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import { Reveal } from "./LandingKit";
import { PaperHero } from "./PaperHero";
import { CornerMarks, MonoLabel, PAPER_ACCENT } from "./PaperKit";
import { ToneCanvas, ToneSection } from "./LandingTone";

/* ═══ Contact ════════════════════════════════════════════════════════════════
   Lifted out of OtherPages, which is still the old marketing shell, and onto
   the same system as home and pricing: one tone canvas, the left-aligned paper
   hero, square fields on hairlines, register marks on every surface.

   ── The UX, which is most of the work here ──────────────────────────────────
   A contact form is the one page on a marketing site where a design failure
   costs a lead, so this one is built to the boring rules rather than the
   pretty ones:

   · every field has a real <label> bound by id. The old version had labels that
     were not associated with anything, so a click on "Email" did not focus the
     email box and a screen reader read the form as five unnamed inputs;
   · the submit button says what will happen. It opens a mail client, which is
     surprising enough that it should be stated before the click, not after;
   · errors are shown per field and announced once, on submit — never live while
     someone is still typing their address;
   · the reason picker is a radiogroup with arrow-key support, because that is
     what a row of mutually exclusive options is;
   · the status line is `role="status"`, so the outcome is announced instead of
     only appearing.                                                          */

const INK = "#111111";
const GREY = "#777777";
const RULE = "rgba(17,17,17,0.12)";

const REASONS = [
  { value: "sales", label: "Sales / Enterprise" },
  { value: "assessment", label: "Readiness assessment" },
  { value: "support", label: "Product support" },
  { value: "partnership", label: "Partnership" },
  { value: "press", label: "Press" },
];

const OFFICES = [
  { city: "Paris", country: "France" },
  { city: "Lisbon", country: "Portugal" },
];

const DIRECT = [
  { icon: Mail, label: "hello@founderos.dev", href: "mailto:hello@founderos.dev" },
  { icon: Phone, label: "+33 1 23 45 67 89", href: "tel:+33123456789" },
  { icon: Calendar, label: "Book 30 minutes", href: "/contact" },
];

/** One field, with its label bound and its error owned. */
function Field({
  label,
  error,
  hint,
  required,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: (props: { id: string; describedBy?: string; invalid: boolean }) => React.ReactNode;
}) {
  const id = useId();
  const errId = `${id}-err`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-[13.5px]" style={{ color: INK }}>
        {label}
        {!required && <span style={{ color: GREY }}> · optional</span>}
      </label>
      {children({ id, describedBy, invalid: !!error })}
      {hint && (
        <p id={hintId} className="mt-1.5 text-[12.5px]" style={{ color: GREY }}>
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} className="mt-1.5 text-[12.5px]" style={{ color: "#B42318" }}>
          {error}
        </p>
      )}
    </div>
  );
}

const inputClass =
  "h-11 w-full border bg-white px-3.5 text-[15px] outline-none transition-colors placeholder:text-[#9A9A9A] focus:border-[#176995] focus-visible:ring-2 focus-visible:ring-[#176995]/25";

export function ContactPage() {
  useEffect(() => {
    document.documentElement.classList.add("mkt-no-scrollbar", "amp-root");
    return () => document.documentElement.classList.remove("mkt-no-scrollbar", "amp-root");
  }, []);

  const [reason, setReason] = useState("sales");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  // Validation only after a submit attempt: telling someone their email is
  // invalid while they are on the third character of it is noise, not help.
  const [tried, setTried] = useState(false);

  const errors = {
    name: !name.trim() ? "Tell us who you are." : undefined,
    email: !email.trim()
      ? "We need somewhere to reply."
      : !/^\S+@\S+\.\S+$/.test(email.trim())
        ? "That does not look like an email address."
        : undefined,
    message: !message.trim() ? "A sentence is enough." : undefined,
  };
  const invalid = Object.values(errors).some(Boolean);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    if (invalid) {
      /* Send focus to the first thing that is wrong rather than leaving the
         person to hunt for it. After the paint, not before: `setTried` has not
         committed yet at this point, so querying for [aria-invalid] here finds
         nothing and the focus silently stays on the button. */
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
      });
      return;
    }
    setStatus("sending");
    try {
      const label = REASONS.find((r) => r.value === reason)?.label ?? reason;
      const body = encodeURIComponent(`Reason: ${label}\nCompany: ${company}\n\n${message}\n\n${name}`);
      window.location.href = `mailto:hello@founderos.dev?subject=${encodeURIComponent(
        `${label} — ${name}`,
      )}&body=${body}`;
      setStatus("sent");
    } catch {
      setStatus("error");
    }
  }

  /* Arrow keys move between the options, which is what makes a row of mutually
     exclusive buttons a radiogroup rather than five unrelated buttons. */
  function onReasonKey(e: React.KeyboardEvent, i: number) {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (i + step + REASONS.length) % REASONS.length;
    setReason(REASONS[next].value);
    document.getElementById(`reason-${REASONS[next].value}`)?.focus();
  }

  return (
    <div className="amplify min-h-screen text-white" style={{ backgroundColor: "transparent" }}>
      <LandingNav />

      <ToneCanvas initial="paper">
        <ToneSection tone="paper">
          <PaperHero
            align="left"
            tiles={[]}
            frame={[]}
            claim="Tell us what you are trying to put an agent on"
            note={
              <>
                <Check className="h-3.5 w-3.5" style={{ color: PAPER_ACCENT }} weight="bold" />
                <span className="font-mono text-[11.5px] uppercase tracking-[0.11em]">
                  We reply within one working day
                </span>
              </>
            }
          />
        </ToneSection>

        <ToneSection tone="paper">
          <div className="mx-auto max-w-[1420px] px-5 pb-24 sm:px-9 sm:pb-28" style={{ color: INK }}>
            <div className="grid gap-6 lg:grid-cols-[1fr_360px] lg:items-start">
              {/* ── The form ─────────────────────────────────────────────── */}
              <Reveal>
                <form
                  onSubmit={handleSubmit}
                  noValidate
                  className="relative bg-[#F7F7F7] p-7 sm:p-10"
                >
                  <CornerMarks accent />

                  <fieldset>
                    <legend className="mb-3">
                      <MonoLabel>What is this about</MonoLabel>
                    </legend>
                    <div role="radiogroup" aria-label="Reason for contact" className="flex flex-wrap gap-2">
                      {REASONS.map((r, i) => {
                        const on = reason === r.value;
                        return (
                          <button
                            key={r.value}
                            id={`reason-${r.value}`}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            tabIndex={on ? 0 : -1}
                            onKeyDown={(e) => onReasonKey(e, i)}
                            onClick={() => setReason(r.value)}
                            className="border px-4 py-2.5 text-[13.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#176995]/35"
                            style={
                              on
                                ? { background: INK, borderColor: INK, color: "#FFFFFF" }
                                : { background: "#FFFFFF", borderColor: RULE, color: GREY }
                            }
                          >
                            {r.label}
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>

                  <div className="mt-8 grid gap-5 sm:grid-cols-2">
                    <Field label="Your name" required error={tried ? errors.name : undefined}>
                      {({ id, describedBy, invalid }) => (
                        <input
                          id={id}
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          aria-invalid={invalid || undefined}
                          aria-describedby={describedBy}
                          className={inputClass}
                          style={{ borderColor: invalid ? "#B42318" : RULE, color: INK }}
                        />
                      )}
                    </Field>

                    <Field label="Email" required error={tried ? errors.email : undefined}>
                      {({ id, describedBy, invalid }) => (
                        <input
                          id={id}
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          aria-invalid={invalid || undefined}
                          aria-describedby={describedBy}
                          className={inputClass}
                          style={{ borderColor: invalid ? "#B42318" : RULE, color: INK }}
                        />
                      )}
                    </Field>
                  </div>

                  <div className="mt-5">
                    <Field label="Company">
                      {({ id }) => (
                        <input
                          id={id}
                          value={company}
                          onChange={(e) => setCompany(e.target.value)}
                          className={inputClass}
                          style={{ borderColor: RULE, color: INK }}
                        />
                      )}
                    </Field>
                  </div>

                  <div className="mt-5">
                    <Field
                      label="Message"
                      required
                      hint="The process you have in mind, and what makes it painful today."
                      error={tried ? errors.message : undefined}
                    >
                      {({ id, describedBy, invalid }) => (
                        <textarea
                          id={id}
                          value={message}
                          onChange={(e) => setMessage(e.target.value)}
                          rows={6}
                          aria-invalid={invalid || undefined}
                          aria-describedby={describedBy}
                          className="w-full border bg-white px-3.5 py-3 text-[15px] leading-[1.6] outline-none transition-colors placeholder:text-[#9A9A9A] focus:border-[#176995] focus-visible:ring-2 focus-visible:ring-[#176995]/25"
                          style={{ borderColor: invalid ? "#B42318" : RULE, color: INK }}
                        />
                      )}
                    </Field>
                  </div>

                  <div className="mt-8 flex flex-wrap items-center gap-4 border-t pt-7" style={{ borderColor: RULE }}>
                    <button
                      type="submit"
                      disabled={status === "sending"}
                      className="inline-flex items-center gap-2.5 px-6 py-3 text-[14.5px] font-medium text-white transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#176995]/40 focus-visible:ring-offset-2 disabled:opacity-50"
                      style={{ background: PAPER_ACCENT }}
                    >
                      {status === "sending" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <ArrowRight className="h-4 w-4" />
                      )}
                      Send message
                    </button>
                    {/* Said before the click, not after: this opens a mail
                        client, which is not what "Send" usually means. */}
                    <span className="text-[13px]" style={{ color: GREY }}>
                      Opens your mail app with the message filled in.
                    </span>
                  </div>

                  <p role="status" aria-live="polite" className="mt-4 text-[13.5px]" style={{ color: GREY }}>
                    {status === "sent" && "Your mail app should be open — press send there to reach us."}
                    {status === "error" && "That did not work. Write to hello@founderos.dev directly."}
                    {tried && invalid && status === "idle" && "Some fields still need filling in."}
                  </p>
                </form>
              </Reveal>

              {/* ── The sidecar ──────────────────────────────────────────── */}
              <div className="space-y-5">
                <Reveal delay={90}>
                  <div className="relative bg-white p-7" style={{ boxShadow: `inset 0 0 0 1px ${RULE}` }}>
                    <CornerMarks />
                    <MonoLabel>Reach us directly</MonoLabel>
                    <ul className="mt-5 space-y-3.5">
                      {DIRECT.map((d) => {
                        const I = d.icon;
                        return (
                          <li key={d.label}>
                            <a
                              href={d.href}
                              className="group inline-flex items-center gap-3 text-[14.5px] transition-colors"
                              style={{ color: INK }}
                            >
                              <I className="h-4 w-4 shrink-0" style={{ color: GREY }} />
                              <span className="underline decoration-transparent underline-offset-4 transition-colors group-hover:decoration-[#176995]">
                                {d.label}
                              </span>
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </Reveal>

                <Reveal delay={150}>
                  <div className="relative bg-white p-7" style={{ boxShadow: `inset 0 0 0 1px ${RULE}` }}>
                    <CornerMarks />
                    <MonoLabel>Where we are</MonoLabel>
                    <ul className="mt-5 space-y-3">
                      {OFFICES.map((o) => (
                        <li key={o.city} className="flex items-center gap-3 text-[14.5px]">
                          <MapPin className="h-4 w-4 shrink-0" style={{ color: GREY }} />
                          <span style={{ color: INK }}>
                            {o.city}
                            <span style={{ color: GREY }}> · {o.country}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-5 border-t pt-5 text-[13.5px] leading-[1.55]" style={{ borderColor: RULE, color: GREY }}>
                      Data stays in the EU. Agents run in your tenant, in your region.
                    </p>
                  </div>
                </Reveal>

                <Reveal delay={210}>
                  <div className="relative bg-[#F7F7F7] p-7">
                    <CornerMarks />
                    <MonoLabel>Not sure yet?</MonoLabel>
                    <p className="mt-4 text-[14.5px] leading-[1.6]" style={{ color: INK }}>
                      The readiness assessment is a standalone engagement. Two to three weeks, a scored
                      roadmap, and no commitment after it.
                    </p>
                    <Link
                      to="/solutions/readiness"
                      className="group mt-5 inline-flex items-center gap-2 text-[14px]"
                      style={{ color: PAPER_ACCENT }}
                    >
                      <span className="underline decoration-transparent underline-offset-4 transition-colors group-hover:decoration-current">
                        How the assessment runs
                      </span>
                      <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  </div>
                </Reveal>
              </div>
            </div>
          </div>
        </ToneSection>

        <ToneSection tone="ink">
          <LandingFooter band="transparent" />
        </ToneSection>
      </ToneCanvas>
    </div>
  );
}
