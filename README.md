# Checkout MB WAY + Multibanco — API Broski

Node 22 + Express 5 (ESM). Uma dependência obrigatória: `express`.
`pg` e `nodemailer` são opcionais e só entram nos caminhos que os usam.

Para arrancar e para os passos de produção, ver `ENTREGA.md`.
Este ficheiro explica **como funciona por dentro** e **o que não se pode mudar
sem partir alguma coisa**.

---

## Mapa dos ficheiros

| Ficheiro | O que faz |
|---|---|
| `server.js` | Rotas: `/api/checkout`, `/api/orders/:ref/status`, `/api/orders/:ref/refund`, `/webhooks/broski`. Contém o `CATALOG`. |
| `lib/broski.js` | Cliente da API. Idempotência, backoff no 429, normalização de telemóvel. A `sk_live_` só existe aqui. |
| `lib/webhook.js` | Verificação HMAC-SHA256 da assinatura. Não mexer — passa o vetor oficial das docs. |
| `lib/store.js` | Persistência em JSON. Escrita atómica e serializada. |
| `lib/store.pg.js` | Persistência em Postgres. Mesma API pública. |
| `lib/mailer.js` | Voucher Multibanco e recibo. Sem `SMTP_URL`, escreve no stdout. |
| `public/index.html` | Formulário, ecrã de espera MB WAY, voucher Multibanco. |
| `test/mock-broski.js` | API Broski falsa, para correr tudo sem conta e sem dinheiro. |

---

## As oito regras que custam dinheiro

**1. O valor vem sempre do servidor.**
`resolveItem()` lê o `amount` do `CATALOG`; o que vier no corpo do pedido é
ignorado. A única exceção é `doacao-livre`, e aí o valor é validado no
servidor (inteiro, entre o mínimo e o máximo). Sem isto, qualquer pessoa
edita o pedido no browser e paga €0,01 pelo que devia custar €1.000.

**2. O polling é ao nosso endpoint, nunca à API Broski.**
O browser faz `GET /api/orders/:ref/status` de 2,5 em 2,5 s. O limite da
Broski é 120 pedidos por minuto **por chave, global**: cinquenta pessoas em
checkout ao mesmo tempo esgotam-no e a loja inteira passa a receber 429.
O estado chega por webhook; o `GET` à Broski é um fallback único por pedido,
protegido por `claimFallback()`.

**3. Multibanco é ecrã final.**
Referência emitida = fim do fluxo do browser. Sem spinner, sem polling. O
pagamento pode acontecer dias depois, e chega por webhook. Um ecrã de espera
aqui fica pendurado para sempre.

**4. Nada é entregue fora do `order.paid`.**
Nem em `awaiting_payment`, nem no 201 do checkout, nem no fallback. A entrega
está no handler do webhook e é decidida pelo retorno de `markFulfilled()` —
que é o próprio `UPDATE ... WHERE fulfilled = false`, não uma leitura
anterior. Com dois `order.paid` simultâneos, só um passa: um recibo, não dois.

**5. Confiar no `status`, não no `type` do evento.**
Os eventos chegam **sem ordem garantida**. Um `order.awaiting_payment`
atrasado pode chegar depois do `order.paid`. Por isso os stores têm uma tabela
de ordem (`RANK`) e um estado nunca regride: `paid` não volta a `pending`, e o
`amount_refunded` nunca diminui.

**6. Dedupe por `id` do evento, e devolver a marca em caso de erro.**
A entrega é *at-least-once*: o mesmo evento chega mais do que uma vez. O
`seenEvent()` marca-o; se o processamento rebentar a meio, `forgetEvent()`
solta a marca para que o retry (24 h) possa repetir. Sem isso, um erro
transitório marca o evento como visto e a entrega perde-se com o pagamento
já feito.

**7. Conciliação por `amount - amount_refunded`.**
Um estorno **parcial** não muda o `status` nem gera webhook. Um pedido
estornado a 90% continua `paid`. Quem conciliar pelo estado recebe números
errados; usar sempre `netAmount()`.

**8. Responder 2xx ao webhook em menos de 10 s, processar depois.**
O handler responde primeiro e trata do evento num `setImmediate`. O corpo é
lido em `express.raw` **antes** do `express.json`, porque a assinatura é
calculada sobre os bytes crus — qualquer parse pelo meio invalida-a.

---

## Estados de um pedido

```
created ──▶ pending ──────────┐             (MB WAY)
        └─▶ awaiting_payment ─┤             (Multibanco)
                              ├──▶ paid ──▶ refunded
                              └──▶ failed / expired
```

Ordem usada pelos stores (`RANK`): `created` 0 · `pending` / `awaiting_payment` 1 ·
`expired` / `failed` 2 · `paid` 3 · `refunded` 4. Só se aceita um estado com
peso maior ou igual ao atual.

Uma tentativa nova depois de `failed` ou `expired` leva **referência nova**: a
antiga fica ocupada para sempre do lado da Broski.

---

## Trocar JSON por Postgres

```bash
npm i pg
export DATABASE_URL=postgres://utilizador:password@host:5432/base
```

No `server.js`, trocar a linha de import:

```js
// import * as store from './lib/store.js';
import * as store from './lib/store.pg.js';
```

`init()` cria as tabelas com `CREATE TABLE IF NOT EXISTS`. A API pública é
idêntica — 11 exports dos dois lados — e toda a concorrência está resolvida
num único statement por operação, sem `SELECT` antes do `UPDATE`.

**Antes de confiar nisto:** o `store.pg.js` nunca correu contra uma base real.
Subir um Postgres, apontar o `DATABASE_URL`, trocar o import dentro do
`test/store.test.js` e correr os mesmos 13 testes. É o mesmo contrato; se
passarem, está provado.

---

## E-mail

```bash
npm i nodemailer
export SMTP_URL='smtps://utilizador:password@smtp.exemplo.pt:465'
export MAIL_FROM='Nome da Campanha <donativos@exemplo.pt>'
export ORG_NAME='Nome da Campanha'
```

Sem `SMTP_URL`, o `mailer.js` escreve as mensagens no stdout e o servidor
arranca na mesma — dá para desenvolver sem SMTP, mas **não se abre ao público
assim**: o voucher Multibanco é a única cópia da referência que o doador tem,
e a Broski não contacta o cliente final.

Os dois envios são *fire-and-forget*, fora do caminho da resposta: um SMTP
lento não atrasa o checkout, e uma falha de e-mail não anula um pedido já
criado na Broski. Em contrapartida, uma falha só aparece no log — vale a pena
vigiar `[email] ... falhou` em produção.

---

## Variáveis de ambiente

| Variável | Obrigatória | Para quê |
|---|---|---|
| `BROSKI_SECRET_KEY` | sim | `sk_live_`. Nunca em código, log ou resposta HTTP. |
| `BROSKI_WEBHOOK_SECRET` | sim | `whbroski_`, do painel. Valida a assinatura. |
| `PUBLIC_URL` | sim | URL público. Entra no `checkout_url` do pedido. |
| `BROSKI_BASE_URL` | não | Só para o mock. Em produção **não definir**. |
| `DATABASE_URL` | com Postgres | Ligação ao Postgres. |
| `SMTP_URL`, `MAIL_FROM`, `ORG_NAME` | para e-mail | Transporte e remetente. |
| `PORT` | não | Predefinição 3000. |

---

## Testes

```bash
npm test      # 21 unitários: assinatura HMAC, telemóvel PT, store
npm run e2e   # 35 checks ponta-a-ponta, com o mock a correr
```

O `e2e.js` precisa do mock e do servidor no ar, e do **mesmo**
`BROSKI_WEBHOOK_SECRET` nos dois processos — se diferirem, o mock assina com
um segredo, o servidor valida com outro, e tudo cai em 400.
