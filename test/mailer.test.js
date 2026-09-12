// Testa a resiliencia do mailer com um servidor SMTP a serio que se pode
// derrubar e levantar a meio. Sem isto, "o mailer recupera" e so uma afirmacao.
//
// Precisa de nodemailer: npm i nodemailer
// Sem nodemailer instalado, os testes sao saltados (nao falham).
import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';

let temNodemailer = true;
try { await import('nodemailer'); } catch { temNodemailer = false; }

/** SMTP de brincar: aceita o dialogo minimo e conta as mensagens entregues. */
function servidorSmtp() {
  let entregues = 0;
  const server = net.createServer((sock) => {
    let emDados = false;
    sock.write('220 localhost ESMTP\r\n');
    sock.on('data', (buf) => {
      for (const linha of buf.toString('utf8').split('\r\n')) {
        if (!linha) continue;
        if (emDados) {
          if (linha === '.') { emDados = false; entregues++; sock.write('250 OK\r\n'); }
          continue;
        }
        const cmd = linha.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (cmd === 'AUTH') sock.write('235 OK\r\n');
        else if (cmd === 'MAIL' || cmd === 'RCPT') sock.write('250 OK\r\n');
        else if (cmd === 'DATA') { emDados = true; sock.write('354 End with .\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 Bye\r\n'); sock.end(); }
        else if (cmd === 'RSET' || cmd === 'NOOP') sock.write('250 OK\r\n');
        else sock.write('250 OK\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return {
    server,
    entregues: () => entregues,
    ouvir: (porta) => new Promise((r) => server.listen(porta, '127.0.0.1', r)),
    fechar: () => new Promise((r) => server.close(r)),
  };
}

const PORTA = 32587;
const rec = {
  external_reference: 'ped-teste-1',
  amount: 3000,
  amount_refunded: 0,
  method: 'multibanco',
  customer: { email: 'doador@exemplo.pt' },
  multibanco: { entity: '11249', reference: '123 456 789', amount: 3000, expires_at: '2026-09-12T00:00:00Z' },
};

test('mailer recupera quando o SMTP cai a meio e volta', { skip: !temNodemailer }, async () => {
  process.env.SMTP_URL = `smtp://u:p@127.0.0.1:${PORTA}?ignoreTLS=true`;
  process.env.MAIL_FROM = 'Teste <no-reply@exemplo.pt>';
  process.env.SMTP_RETRY_MS = '1';           // sem cooldown, para o teste correr rapido
  const mailer = await import('../lib/mailer.js?v=' + Date.now());

  // 1) SMTP em pe: envia.
  const s1 = servidorSmtp();
  await s1.ouvir(PORTA);
  const r1 = await mailer.enviarVoucher(rec);
  assert.equal(r1.enviado, true, 'devia enviar com o SMTP em pe');
  assert.equal(s1.entregues(), 1);

  // 2) SMTP cai DEPOIS do verify() ter passado — era aqui que o transporte
  //    ficava em cache e todas as mensagens seguintes rebentavam para sempre.
  await s1.fechar();
  await assert.rejects(() => mailer.enviarRecibo(rec), 'devia propagar a falha, nao engolir');

  // 3) SMTP volta: a mensagem seguinte tem de passar, sem reiniciar o processo.
  const s2 = servidorSmtp();
  await s2.ouvir(PORTA);
  const r3 = await mailer.enviarRecibo(rec);
  assert.equal(r3.enviado, true, 'devia recuperar sozinho apos o SMTP voltar');
  assert.equal(s2.entregues(), 1);
  await s2.fechar();
});

test('mailer arranca sem SMTP e recupera quando o SMTP aparece', { skip: !temNodemailer }, async () => {
  process.env.SMTP_URL = `smtp://u:p@127.0.0.1:${PORTA + 1}?ignoreTLS=true`;
  process.env.SMTP_RETRY_MS = '1';
  const mailer = await import('../lib/mailer.js?v=' + Date.now());

  // Nada a escutar: cai para stdout, mas NAO memoriza a falha para sempre.
  const r1 = await mailer.enviarVoucher(rec);
  assert.equal(r1.enviado, false);
  assert.equal(r1.motivo, 'sem_transporte');

  const s = servidorSmtp();
  await s.ouvir(PORTA + 1);
  const r2 = await mailer.enviarVoucher(rec);
  assert.equal(r2.enviado, true, 'devia ligar-se assim que o SMTP apareceu');
  await s.fechar();
});

test('sem destinatario nao tenta enviar', { skip: !temNodemailer }, async () => {
  const mailer = await import('../lib/mailer.js?v=' + Date.now());
  const r = await mailer.enviarRecibo({ ...rec, customer: {} });
  assert.equal(r.enviado, false);
  assert.equal(r.motivo, 'sem_destinatario');
});

test('pedido sem voucher Multibanco nao gera e-mail de voucher', { skip: !temNodemailer }, async () => {
  const mailer = await import('../lib/mailer.js?v=' + Date.now());
  const r = await mailer.enviarVoucher({ ...rec, multibanco: null });
  assert.equal(r.enviado, false);
  assert.equal(r.motivo, 'sem_multibanco');
});
