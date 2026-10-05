import { useId, useState } from "react";
import { HnPage } from "./hn/HnPage";
import { Btn, Card, H, P } from "./hn/HnKit";

/* ═══ Contact ════════════════════════════════════════════════════════════════
   hunar.ai's "Get in touch" layout: a big title on the off-white ground, then
   white cards — the inbox, where we work, and the form opened up inside the
   card the reference calls "Sales". The phone number that used to sit here was
   a placeholder (+33 1 23 45 67 89) and is gone until there is a real one.

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

const INK = "#0f1728";
const GREY = "#4b5567";

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
      <label htmlFor={id} className="mb-2 block text-[16px] font-medium" style={{ color: INK }}>
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
  "h-11 w-full rounded-full border bg-white px-4 text-[16px] text-[#0f1728] outline-none transition-colors placeholder:text-[#8a94a6] focus:border-[#006edd]";

export function ContactPage() {
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
        `${label}, ${name}`,
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
    <HnPage>
      <section className="bg-[#f7f8fb]">
        <div className="mx-auto w-full max-w-[1046px] px-5 pb-20 pt-16 sm:px-12 lg:pt-24">
          <H as="h1" size="hero">Get in touch</H>
          <P className="mt-4 max-w-[640px]">
            Tell us what you are trying to put an agent on. We reply within one working day.
          </P>

          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            <Card hover className="p-6">
              <div className="text-[18px] leading-[1.3] text-[#4b5567]">General inquiries</div>
              <a href="mailto:hello@founderos.dev" className="mt-6 block text-[24px] font-medium leading-[1.2] tracking-[-0.04em] text-[#0f1728] hover:text-[#006edd]">
                hello@founderos.dev
              </a>
            </Card>
            <Card hover className="p-6">
              <div className="text-[18px] leading-[1.3] text-[#4b5567]">Where we work</div>
              <div className="mt-6 text-[24px] font-medium leading-[1.2] tracking-[-0.04em] text-[#0f1728]">
                {OFFICES.map((o) => o.city).join(" · ")}
              </div>
              <div className="mt-2 text-[16px] text-[#4b5567]">Data stays in the EU. Agents run in your tenant, in your region.</div>
            </Card>
          </div>

          {/* ══ The form — the reference's "Sales" card, opened up ═══════════ */}
          <Card className="mt-4 p-6 sm:p-8">
            <div className="text-[18px] leading-[1.3] text-[#4b5567]">Sales, support and everything else</div>
            <form onSubmit={handleSubmit} noValidate className="mt-6">
              <div className="text-[16px] font-medium text-[#0f1728]">What is this about?</div>
              <div role="radiogroup" aria-label="Reason" className="mt-3 flex flex-wrap gap-2">
                {REASONS.map((r, i) => {
                  const on = r.value === reason;
                  return (
                    <button
                      key={r.value}
                      id={`reason-${r.value}`}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      tabIndex={on ? 0 : -1}
                      onClick={() => setReason(r.value)}
                      onKeyDown={(e) => onReasonKey(e, i)}
                      className={`rounded-full border px-3.5 py-2 text-[16px] font-medium leading-none tracking-[-0.02em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#006edd]/40 ${
                        on ? "border-[#006edd] bg-[#006edd] text-white" : "border-[#e6e9ef] bg-white text-[#0f1728] hover:border-[#cfd5df]"
                      }`}
                    >
                      {r.label}
                    </button>
                  );
                })}
              </div>

              <div className="mt-8 grid gap-5 sm:grid-cols-2">
                <Field label="Your name" required error={tried ? errors.name : undefined}>
                  {({ id, describedBy, invalid: bad }) => (
                    <input
                      id={id}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      autoComplete="name"
                      aria-invalid={bad}
                      aria-describedby={describedBy}
                      className={inputClass}
                      style={{ borderColor: bad ? "#B42318" : "#e6e9ef" }}
                    />
                  )}
                </Field>
                <Field label="Email" required error={tried ? errors.email : undefined}>
                  {({ id, describedBy, invalid: bad }) => (
                    <input
                      id={id}
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoComplete="email"
                      aria-invalid={bad}
                      aria-describedby={describedBy}
                      className={inputClass}
                      style={{ borderColor: bad ? "#B42318" : "#e6e9ef" }}
                    />
                  )}
                </Field>
              </div>
              <div className="mt-5">
                <Field label="Company">
                  {({ id, describedBy }) => (
                    <input
                      id={id}
                      value={company}
                      onChange={(e) => setCompany(e.target.value)}
                      autoComplete="organization"
                      aria-describedby={describedBy}
                      className={inputClass}
                      style={{ borderColor: "#e6e9ef" }}
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
                  {({ id, describedBy, invalid: bad }) => (
                    <textarea
                      id={id}
                      rows={5}
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      aria-invalid={bad}
                      aria-describedby={describedBy}
                      className="w-full rounded-[18px] border bg-white px-4 py-3 text-[16px] leading-[1.5] text-[#0f1728] outline-none transition-colors placeholder:text-[#8a94a6] focus:border-[#006edd]"
                      style={{ borderColor: bad ? "#B42318" : "#e6e9ef" }}
                    />
                  )}
                </Field>
              </div>

              <div className="mt-8 flex flex-wrap items-center gap-4 border-t border-[#e6e9ef] pt-6">
                <Btn type="submit">{status === "sending" ? "Opening your mail app…" : "Send message"}</Btn>
                {/* Said before the click, not after: this opens a mail client,
                    which is not what "Send" usually means. */}
                <span className="text-[15px] text-[#4b5567]">Opens your mail app with the message filled in.</span>
              </div>
              <p className="mt-3 text-[15px]" role="status" aria-live="polite">
                {status === "sent" && <span className="text-[#1a7f3c]">Your mail app should be open with the message ready to send.</span>}
                {status === "error" && <span className="text-[#B42318]">That did not work. Write to hello@founderos.dev directly.</span>}
              </p>
            </form>
          </Card>

          <Card className="mt-4 flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-[18px] leading-[1.3] text-[#4b5567]">Not sure yet?</div>
              <div className="mt-2 text-[18px] leading-[1.3] text-[#0f1728]">
                The readiness assessment is a standalone engagement: two to three weeks, a scored roadmap, and no
                commitment after it.
              </div>
            </div>
            <Btn to="/solutions/readiness" variant="link" className="shrink-0">How the assessment runs</Btn>
          </Card>
        </div>
      </section>
    </HnPage>
  );
}
