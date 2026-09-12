// E-mail transacional. Duas mensagens, so estas:
//   1. voucher Multibanco  — logo apos criar o pedido, e a UNICA copia da
//      referencia que o doador tem. A Broski nao contacta o cliente final:
//      sem este e-mail, quem fechar o separador perde a referencia e o
//      pagamento nunca acontece.
//   2. recibo              — depois do webhook order.paid, nunca antes.
//
// Transporte: nodemailer via SMTP_URL. Se o nodemailer nao estiver instalado
// ou o SMTP_URL nao estiver definido, escreve no stdout em vez de enviar —
// o servidor arranca na mesma e o fluxo de pagamento nao fica preso ao e-mail.
//
//   npm i nodemailer
//   SMTP_URL=smtps://utilizador:password@smtp.exemplo.pt:465
//   MAIL_FROM="Nome da Campanha <donativos@exemplo.pt>"

const SMTP_URL = process.env.SMTP_URL || null;
const FROM = process.env.MAIL_FROM || 'no-reply@localhost';
const ORG = process.env.ORG_NAME || 'a campanha';
// Enquanto o SMTP estiver em baixo, nao tentar ligar a cada mensagem: seria
// uma ligacao TCP por doacao contra um servidor morto.
const RETRY_MS = Number(process.env.SMTP_RETRY_MS || 60_000);

let transporter = null;
let avisouSemUrl = false;
let proximaTentativa = 0;

// Sem SMTP_URL nunca ha transporte — nao vale a pena tentar.
// COM SMTP_URL, uma falha NAO e memorizada para sempre: passado RETRY_MS a
// mensagem seguinte volta a tentar ligar. Memorizar a falha deixaria os
// vouchers a sair para o stdout ate alguem reiniciar o processo — e como o
// envio e fire-and-forget, ninguem daria conta.
async function obterTransporte() {
  if (!SMTP_URL) {
    if (!avisouSemUrl) {
      console.warn('[email] SMTP_URL não definido — as mensagens vão para o stdout, não são enviadas.');
      avisouSemUrl = true;
    }
    return null;
  }
  if (transporter) return transporter;
  if (Date.now() < proximaTentativa) return null;   // cooldown
  try {
    const { default: nodemailer } = await import('nodemailer');
    const t = nodemailer.createTransport(SMTP_URL);
    await t.verify();
    transporter = t;
    proximaTentativa = 0;
    console.log('[email] SMTP ligado.');
  } catch (err) {
    // ALERTA: se isto aparecer repetido, os vouchers Multibanco nao estao a
    // chegar aos doadores e cada um deles e um donativo que nunca acontece.
    console.error('[email] ALERTA: SMTP indisponível, a escrever no stdout:', err.message);
    transporter = null;
    proximaTentativa = Date.now() + RETRY_MS;
  }
  return transporter;
}

const eur = (c) => '€' + (c / 100).toFixed(2).replace('.', ',');

async function enviar({ to, subject, text, html }) {
  if (!to) return { enviado: false, motivo: 'sem_destinatario' };
  const t = await obterTransporte();
  if (!t) {
    console.log(`\n[email:stdout] para: ${to}\n[email:stdout] assunto: ${subject}\n${text}\n`);
    return { enviado: false, motivo: 'sem_transporte' };
  }
  try {
    await t.sendMail({ from: FROM, to, subject, text, html });
  } catch (err) {
    // O verify() passou no arranque mas o SMTP caiu entretanto. Sem isto o
    // transporte ficava em cache e TODAS as mensagens seguintes rebentavam,
    // em silencio (o chamador e fire-and-forget). Deita fora o transporte
    // para a proxima mensagem reconstruir a ligacao.
    transporter = null;
    proximaTentativa = Date.now() + RETRY_MS;
    console.error(`[email] ALERTA: envio de "${subject}" para ${to} falhou:`, err.message);
    throw err;   // relanca: o chamador loga, e o alerta fica no log
  }
  console.log(`[email] "${subject}" enviado para ${to}`);
  return { enviado: true };
}

/** Voucher Multibanco. Chamar logo apos criar o pedido — nao esperar pelo pagamento. */
export async function enviarVoucher(rec) {
  const mb = rec.multibanco;
  if (!mb) return { enviado: false, motivo: 'sem_multibanco' };

  const validade = mb.expires_at
    ? new Date(mb.expires_at).toLocaleString('pt-PT', { dateStyle: 'long', timeStyle: 'short' })
    : null;

  const linhas = [
    `Entidade: ${mb.entity}`,
    `Referência: ${mb.reference}`,
    `Valor: ${eur(mb.amount ?? rec.amount)}`,
  ];
  if (validade) linhas.push(`Válido até: ${validade}`);

  const text = [
    `Obrigado por apoiar ${ORG}.`,
    '',
    'Para concluir, pague estes dados num Multibanco, no homebanking ou na app do seu banco:',
    '',
    ...linhas,
    '',
    'Assim que o pagamento for confirmado, receberá o recibo por e-mail.',
    `Referência do pedido: ${rec.external_reference}`,
  ].join('\n');

  const html = `
    <p>Obrigado por apoiar ${ORG}.</p>
    <p>Para concluir, pague estes dados num Multibanco, no homebanking ou na app do seu banco:</p>
    <table cellpadding="6" style="border-collapse:collapse;font-size:16px">
      <tr><td>Entidade</td><td><b>${mb.entity}</b></td></tr>
      <tr><td>Referência</td><td><b>${mb.reference}</b></td></tr>
      <tr><td>Valor</td><td><b>${eur(mb.amount ?? rec.amount)}</b></td></tr>
      ${validade ? `<tr><td>Válido até</td><td>${validade}</td></tr>` : ''}
    </table>
    <p>Assim que o pagamento for confirmado, receberá o recibo por e-mail.</p>
    <p style="color:#5a6b7b;font-size:13px">Referência do pedido: ${rec.external_reference}</p>`;

  return enviar({
    to: rec.customer?.email,
    subject: `Dados para pagamento Multibanco — ${eur(mb.amount ?? rec.amount)}`,
    text, html,
  });
}

/** Recibo. So depois do webhook order.paid. */
export async function enviarRecibo(rec) {
  const liquido = rec.amount - (rec.amount_refunded || 0);
  const text = [
    `Recebemos a sua doação de ${eur(liquido)}. Obrigado por apoiar ${ORG}.`,
    '',
    `Referência do pedido: ${rec.external_reference}`,
    `Método: ${rec.method === 'mbway' ? 'MB WAY' : 'Multibanco'}`,
  ].join('\n');

  const html = `
    <p>Recebemos a sua doação de <b>${eur(liquido)}</b>. Obrigado por apoiar ${ORG}.</p>
    <p style="color:#5a6b7b;font-size:13px">
      Referência do pedido: ${rec.external_reference}<br>
      Método: ${rec.method === 'mbway' ? 'MB WAY' : 'Multibanco'}
    </p>`;

  return enviar({
    to: rec.customer?.email,
    subject: `Recibo da sua doação — ${eur(liquido)}`,
    text, html,
  });
}
