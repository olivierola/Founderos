// Les e-mails de l'auth : confirmation d'inscription, réinitialisation du mot
// de passe, invitation, changement d'adresse.
//
// Trois sorties, la première configurée l'emporte :
//   - SMTP (AUTH_SMTP_HOST, AUTH_SMTP_PORT, AUTH_SMTP_USER, AUTH_SMTP_PASS) ;
//   - Resend (RESEND_API_KEY), déjà utilisé par les invitations de l'app ;
//   - sinon la console : le lien est journalisé, pour un poste de dev.
// AUTH_SMTP_SENDER (ou AUTH_MAIL_FROM) : l'expéditeur.

export interface Mail { to: string; subject: string; html: string; text: string }

const FROM = () => process.env.AUTH_SMTP_SENDER || process.env.AUTH_MAIL_FROM || "FounderOS <no-reply@founderos.local>";

export function mailerConfigured(): boolean {
  return !!(process.env.AUTH_SMTP_HOST || process.env.RESEND_API_KEY);
}

export async function sendMail(mail: Mail): Promise<void> {
  if (process.env.AUTH_SMTP_HOST) {
    const { default: nodemailer } = await import("nodemailer");
    const port = Number(process.env.AUTH_SMTP_PORT ?? 587);
    const transport = nodemailer.createTransport({
      host: process.env.AUTH_SMTP_HOST,
      port,
      secure: port === 465,
      auth: process.env.AUTH_SMTP_USER ? { user: process.env.AUTH_SMTP_USER, pass: process.env.AUTH_SMTP_PASS ?? "" } : undefined,
    });
    await transport.sendMail({ from: FROM(), to: mail.to, subject: mail.subject, html: mail.html, text: mail.text });
    return;
  }
  if (process.env.RESEND_API_KEY) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM(), to: [mail.to], subject: mail.subject, html: mail.html, text: mail.text }),
    });
    if (!res.ok) throw new Error(`Resend a refusé l'e-mail (${res.status}) : ${await res.text().catch(() => "")}`);
    return;
  }
  console.log(`[auth] e-mail (aucun envoi configuré) → ${mail.to} : ${mail.subject}\n${mail.text}`);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export function linkMail(to: string, kind: "signup" | "recovery" | "invite" | "email_change" | "magiclink", link: string): Mail {
  const t = {
    signup: ["Confirmez votre adresse", "Confirmez votre adresse e-mail pour activer votre compte :", "Confirmer mon adresse"],
    recovery: ["Réinitialisez votre mot de passe", "Vous avez demandé à réinitialiser votre mot de passe :", "Choisir un nouveau mot de passe"],
    invite: ["Vous êtes invité", "Vous avez été invité à rejoindre FounderOS :", "Accepter l'invitation"],
    email_change: ["Confirmez votre nouvelle adresse", "Confirmez le changement de votre adresse e-mail :", "Confirmer"],
    magiclink: ["Votre lien de connexion", "Voici votre lien de connexion :", "Me connecter"],
  }[kind];
  return {
    to,
    subject: t[0],
    text: `${t[1]}\n${link}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message.`,
    html: `<p>${esc(t[1])}</p><p><a href="${esc(link)}">${esc(t[2])}</a></p><p style="color:#666;font-size:12px">Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.</p>`,
  };
}
