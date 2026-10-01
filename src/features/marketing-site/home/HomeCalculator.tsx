import { useId, useState } from "react";
import NumberFlow from "@number-flow/react";
import {
  CalculatorIcon as Calculator,
  ChartBarIcon as ChartBar,
  ClockIcon as Clock,
  LockSimpleIcon as LockSimple,
  QuestionIcon as Question,
  ShieldCheckIcon as ShieldCheck,
  SlidersHorizontalIcon as Sliders,
  TargetIcon as Target,
} from "@phosphor-icons/react";
import { Reveal } from "../LandingKit";
import { Btn, Container, Eyebrow, Heading, IconOrb, Section } from "../atlas/AtlasKit";

/* ══ The calculator ══════════════════════════════════════════════════════════
   The reference asks what revenue you are leaving on the table and answers
   with a recovery rate of its own. We only multiply what you type: hours on
   repetitive work, and the share of it YOU say you would hand to agents. No
   coefficient of ours sits in the result, and nothing leaves the browser.  */

const WEEKS = 46; // working weeks in a year, holidays taken out

type Field = {
  key: "people" | "hours" | "cost" | "share";
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
  ticks: string[];
  format: (v: number) => string;
};

const FIELDS: Field[] = [
  {
    key: "people",
    label: "People doing repetitive work",
    help: "Everyone who spends part of the week copying, checking, chasing or reformatting.",
    min: 1,
    max: 200,
    step: 1,
    ticks: ["1", "50", "100", "200"],
    format: (v) => `${v}`,
  },
  {
    key: "hours",
    label: "Hours a week, each",
    help: "The part of each person's week that follows a rule someone could write down.",
    min: 1,
    max: 30,
    step: 1,
    ticks: ["1h", "10h", "20h", "30h"],
    format: (v) => `${v}h`,
  },
  {
    key: "cost",
    label: "Loaded hourly cost",
    help: "Salary plus charges, per hour.",
    min: 20,
    max: 150,
    step: 5,
    ticks: ["€20", "€60", "€100", "€150"],
    format: (v) => `€${v}`,
  },
  {
    key: "share",
    label: "Share you would hand to agents",
    help: "Your own estimate. The readiness scan is how you find the real figure.",
    min: 10,
    max: 80,
    step: 5,
    ticks: ["10%", "30%", "55%", "80%"],
    format: (v) => `${v}%`,
  },
];

function Slider({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: number;
  onChange: (v: number) => void;
}) {
  const id = useId();
  const fill = ((value - field.min) / (field.max - field.min)) * 100;
  return (
    <div className="rounded-[22px] border border-[#ededed] bg-white p-5">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor={id} className="flex items-center gap-2 text-[15.5px] font-semibold tracking-[-0.02em]">
          {field.label}
          <span title={field.help} className="grid h-5 w-5 place-items-center rounded-full bg-[#f3f3f3] text-[#666666]">
            <Question className="h-3 w-3" />
          </span>
        </label>
        <span className="min-w-[72px] rounded-[12px] border border-[#ededed] px-3 py-2 text-right text-[15px] font-semibold tabular-nums">
          {field.format(value)}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={field.min}
        max={field.max}
        step={field.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="at-range mt-5"
        style={{ ["--at-fill" as string]: `${fill}%` }}
      />
      <div className="mt-3 flex justify-between text-[13px] text-[#666666]">
        {field.ticks.map((t) => (
          <span key={t}>{t}</span>
        ))}
      </div>
    </div>
  );
}

export function HomeCalculator() {
  const [v, setV] = useState({ people: 20, hours: 8, cost: 45, share: 40 });
  const hoursYear = v.people * v.hours * WEEKS;
  const handed = Math.round(hoursYear * (v.share / 100));
  const value = Math.round((handed * v.cost) / 100) * 100;

  return (
    <Section>
      <Container>
        <div className="grid items-start gap-14 lg:grid-cols-2">
          <Reveal className="lg:sticky lg:top-28">
            <Eyebrow icon={Calculator} accent="Time calculator" />
            <Heading className="mt-8 max-w-[18ch]" lead="How many hours go into work" serif="an agent could take?" />
            <div className="mt-12 grid grid-cols-3 divide-x divide-[#ececec] text-center">
              {[
                { icon: Clock, t: "90 seconds", s: "to a first figure" },
                { icon: LockSimple, t: "100% private", s: "nothing is sent" },
                { icon: Target, t: "Your numbers", s: "not a benchmark" },
              ].map((p) => (
                <div key={p.t} className="flex flex-col items-center px-2">
                  <span className="grid h-10 w-10 place-items-center rounded-full bg-[#f3f3f3]">
                    <p.icon className="h-5 w-5" />
                  </span>
                  <div className="mt-4 text-[15px] font-semibold tracking-[-0.02em]">{p.t}</div>
                  <div className="mt-1 text-[14px] text-[#666666]">{p.s}</div>
                </div>
              ))}
            </div>
          </Reveal>

          <Reveal delay={100}>
            <div className="rounded-[36px] bg-[#f7f7f7] p-2.5">
              <div className="rounded-[30px] bg-[#fbfbfb] p-2.5">
                <div className="flex items-center gap-2.5 px-2 pb-3 pt-2 text-[15px] font-semibold">
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-white shadow-sm">
                    <Sliders className="h-4 w-4" />
                  </span>
                  Your inputs
                </div>
                <div className="space-y-2.5">
                  {FIELDS.map((f) => (
                    <Slider key={f.key} field={f} value={v[f.key]} onChange={(n) => setV((s) => ({ ...s, [f.key]: n }))} />
                  ))}
                </div>
                <div className="flex items-center gap-2.5 px-2 pb-3 pt-6 text-[15px] font-semibold">
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-white shadow-sm">
                    <ChartBar className="h-4 w-4" />
                  </span>
                  Your results
                </div>
                <div className="space-y-2.5">
                  <div className="rounded-[22px] border border-[#ededed] bg-white p-6">
                    <div className="text-[16px] font-semibold tracking-[-0.02em]">Hours a year on repetitive work</div>
                    <div className="mt-2 text-[44px] font-bold leading-none tracking-[-0.05em] tabular-nums text-[#c23cf0]">
                      <NumberFlow value={hoursYear} locales="en-US" format={{ useGrouping: true }} />
                    </div>
                    <div className="mt-2 text-[14px] text-[#111011]">hours / year</div>
                  </div>
                  <div className="rounded-[22px] border border-[#ededed] bg-white p-6">
                    <div className="text-[16px] font-semibold tracking-[-0.02em]">
                      Value of the share you would hand over
                    </div>
                    <div className="mt-2 text-[44px] font-bold leading-none tracking-[-0.05em] tabular-nums text-[#c23cf0]">
                      €<NumberFlow value={value} locales="en-US" format={{ useGrouping: true }} />
                    </div>
                    <div className="mt-2 text-[14px] text-[#111011]">
                      / year · <NumberFlow value={handed} locales="en-US" format={{ useGrouping: true }} /> hours
                    </div>
                  </div>
                </div>
              </div>
              <div className="mt-2.5 flex flex-col gap-4 rounded-[30px] bg-white p-5 sm:flex-row sm:items-center">
                <IconOrb icon={ShieldCheck} size={56} />
                <p className="flex-1 text-[14px] leading-[1.45] text-[#666666]">
                  Estimates computed from your inputs only, in your browser. They are not a promise of what an
                  agent will save — the readiness scan is how you find out.
                </p>
                <Btn to="/contact" variant="dark">
                  Talk to us
                </Btn>
              </div>
            </div>
          </Reveal>
        </div>
      </Container>
    </Section>
  );
}
