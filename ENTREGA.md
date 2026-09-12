# ENTREGA — Checkout MB WAY + Multibanco (API Broski)

Documento para quem vai receber este projeto e pô-lo em produção.
Não é preciso conhecer o histórico: está aqui tudo.

**Estado:** integração completa e testada. 25/25 testes unitários,
35/35 checks ponta-a-ponta. Falta só configuração de ambiente e deploy.

**Stack:** Node.js 22 + Express 5 (ESM). Dependências: `express` (obrigatória)
e `nodemailer` (opcional — sem ela os e-mails vão para o stdout).
Sem build, sem framework de frontend, sem SDK de pagamentos.

---

## 1. Correr em 5 minutos (sem chaves reais)

O projeto traz um mock da API Broski — dá para ver o fluxo inteiro
funcionar sem conta e sem dinheiro.

```bash
npm install

# Terminal 1 — API falsa
BROSKI_WEBHOOK_SECRET=whbroski_mock npm run mock

# Terminal 2 — a aplicação
BROSKI_WEBHOOK_SECRET=whbroski_mock BROSKI_SECRET_KEY=sk_live_fake \
BROSKI_BASE_URL=http://localhost:4010 PUBLIC_URL=http://localhost:3000 npm start

# Terminal 3 — validar
npm test        # 25/25 unitários
npm run e2e     # 35/35 ponta-a-ponta
```

Abre `http://localhost:3000`. O mock confirma MB WAY em ~6 s e Multibanco em ~12 s.
Sem `SMTP_URL`, os e-mails (voucher e recibo) aparecem no stdout do servidor —
dá para ler o conteúdo exato das mensagens sem configurar nada.

> **Windows:** o `BROSKI_WEBHOOK_SECRET=... npm start` não funciona no
> PowerShell. Usa Git Bash, ou `$env:BROSKI_WEBHOOK_SECRET="whbroski_mock"`
> em linha separada.

---

## 2. O que já está resolvido (não refazer)

| | Onde |
|---|---|
| Cliente da API com idempotência e backoff no 429 | `lib/broski.js` |
| Verificação HMAC do webhook (passa o vetor oficial das docs) | `lib/webhook.js` |
| Persistência JSON com escrita atómica | `lib/store.js` |
| Persistência Postgres, mesma API | `lib/store.pg.js` |
| E-mail: voucher Multibanco + recibo | `lib/mailer.js` |
| Checkout, status e estornos | `server.js` |
| UI: formulário, espera MB WAY, voucher Multibanco | `public/index.html` |
| Mock da API para testes locais | `test/mock-broski.js` |

Detalhes de implementação e a tabela de regras da API: ver `README.md`.

---

## 3. Passos para produção

### 3.1 — Conta Broski *(dono do negócio)*
Verificar a conta em app.broski.pt. Pede NIF, certidão/estatutos, IBAN e
CC do responsável. Sem conta aprovada a API devolve `401`.

Depois, em **Configurações → API**, gerar a `sk_live_`.

> A conta tem de estar em nome de quem recebe o dinheiro. Se o checkout
> angaria fundos para uma organização, a conta é da organização — não de
> quem programa, não de um intermediário.

### 3.2 — Adaptar o catálogo *(programador)*
Único ficheiro obrigatório: o `CATALOG` no topo do `server.js`.

```js
const CATALOG = {
  'o-teu-sku': { amount: 1990, description: 'Nome do produto', product_type: 'digital' },
};
```

- `amount` em **cêntimos**, sempre inteiro (€19,90 → `1990`)
- `product_type: 'physical'` passa a exigir `customer.address`
  (`line1`, `postal_code`, `city`)
- Se não quiseres valor livre, apaga o bloco `LIVRE` e o ramo em `resolveItem`

Depois, espelha os mesmos SKU e textos em `public/index.html` (constante no
topo do `<script>`) e troca título, logo e cores.

### 3.3 — Base de dados *(programador)*
O `lib/store.js` grava num JSON — serve para desenvolvimento, mas não aguenta
concorrência a sério. Para produção são **três** passos, não um:

**1. Subir uma base Postgres.** Não basta instalar o cliente. Serviço gerido
(Neon, Supabase, Railway, RDS) ou container:

```bash
docker run -d --name broski-db -e POSTGRES_PASSWORD=segredo -p 5432:5432 postgres:16
```

**2. Instalar o cliente e definir a ligação:**

```bash
npm install pg
export DATABASE_URL="postgres://postgres:segredo@localhost:5432/postgres"
```

**3. Trocar uma linha no `server.js`:**

```js
// import * as store from './lib/store.js';
import * as store from './lib/store.pg.js';
```

O `init()` cria as tabelas sozinho (`CREATE TABLE IF NOT EXISTS`).

⚠ **Corre `npm run e2e` depois de trocar.** O `store.pg.js` tem a mesma API
pública do `store.js` e o SQL foi revisto, mas **nunca chegou a executar** —
o `pg` não estava instalado. Trata a primeira execução como validação, não
como formalidade.

### 3.4 — E-mail transacional *(programador)*
Sem isto o Multibanco fica meio partido: a Broski não contacta o cliente
final, e quem fecha o separador perde a referência para sempre.

```bash
npm install nodemailer
```

Variáveis:

```
SMTP_URL=smtps://utilizador:password@smtp.exemplo.pt:465
MAIL_FROM="Nome da Campanha <donativos@exemplo.pt>"
ORG_NAME="Nome da Campanha"
```

Sem `SMTP_URL` o servidor arranca à mesma e escreve as mensagens no stdout —
dá para ver o conteúdo exato antes de ligar SMTP a sério.

`SMTP_RETRY_MS` (padrão 60000) define quanto tempo esperar antes de voltar a
tentar ligar depois de uma falha. Sem esse intervalo, cada doação abriria uma
ligação TCP nova contra um servidor morto.

Os envios são *fire-and-forget* de propósito: um SMTP lento não pode atrasar
o checkout, e uma falha de e-mail não pode anular um pedido já criado na
Broski. O preço é que a falha só aparece no log — **põe um alerta em
`[email] ALERTA`**, senão os vouchers deixam de sair e ninguém dá conta.

O `test/mailer.test.js` levanta um servidor SMTP de brincar, derruba-o a meio
e volta a levantá-lo, para provar que o envio recupera sozinho sem reiniciar
o processo.

### 3.5 — Deploy com HTTPS *(programador)*
Railway, Render, Fly.io ou VPS com Caddy. O webhook **só aceita HTTPS**.

Variáveis de ambiente (ver `.env.example`):

```
BROSKI_SECRET_KEY=sk_live_...
BROSKI_WEBHOOK_SECRET=whbroski_...
PUBLIC_URL=https://o-teu-dominio.pt
DATABASE_URL=postgres://...
```

**Não definas `BROSKI_BASE_URL`** — em produção aponta sozinho para
`api.broski.pt`. Essa variável existe só para o mock.

### 3.6 — Registar o webhook *(programador)*
Painel → Configurações → Webhooks → `https://o-teu-dominio.pt/webhooks/broski`

⚠ **URL final e exata.** Se o servidor redireciona para `www`, regista com
`www`. Um 3xx conta como entrega falhada e o evento entra em retry 24 h.

Copia o segredo `whbroski_...` para o ambiente e confirma: `npm test`.

### 3.7 — Teste com dinheiro real *(ambos)*
Não existe `sk_test_` — o modo de teste ainda está em desenvolvimento.

1. MB WAY de `50` (€0,50, o mínimo) para o telemóvel de quem testa
2. Confirmar na app
3. Ver o log `[entrega] ... liberado`
4. Estornar: `POST /api/orders/:ref/refund` com `{}`
5. Repetir com Multibanco, pagar a referência no homebanking

Se o webhook não chegar, o painel mostra as entregas e permite reenviar.

### 3.8 — Antes de abrir ao público *(dono do negócio)*
- Termos, Política de Privacidade e política de reembolso publicados
- **SMTP ligado e testado** (ver 3.4). O `mailer.js` já envia o voucher
  Multibanco e o recibo; sem `SMTP_URL` as mensagens só vão para o stdout
- Confirmar que nada é entregue fora do `order.paid`
- Alerta de monitorização sobre `[email] ALERTA` no log

---

## 4. Regras que não podem ser quebradas

Cada uma destas custa dinheiro real quando ignorada:

1. **A `sk_live_` nunca sai do servidor.** Nem em browser, nem em app
   móvel, nem no repositório. A API rejeita chamadas de browser por CORS.
2. **O valor vem sempre do servidor.** O `CATALOG` é a fonte da verdade;
   o que o browser envia é ignorado.
3. **Entrega só no `order.paid`.** Nunca na criação do pedido, nunca com
   base no que o frontend diz.
4. **O browser faz polling do *nosso* endpoint**, nunca do `GET /v1/orders`
   da Broski. O limite de 120 req/min é global por chave — meia dúzia de
   clientes em espera derrubaria a loja em 429.
5. **Multibanco é ecrã final.** Sem spinner, sem polling. A confirmação
   chega horas ou dias depois, por webhook.
6. **Retentativa após `failed`/`expired` = pedido novo**, com
   `external_reference` *e* `Idempotency-Key` novas. A referência antiga
   fica ocupada para sempre.
7. **`409 mbway_pending_for_phone` não é falha de pagamento.** Mostra-se a
   mensagem do PSP e espera-se; criar outro pedido faz o cliente pagar duas
   vezes.
8. **Conciliar por `amount - amount_refunded`**, nunca só pelo status —
   estorno parcial mantém `paid` e não gera webhook.

---

## 5. Divisão de responsabilidades

**Só o dono do negócio pode fazer:**
verificar a conta na Broski · gerar e guardar a `sk_live_` · registar o
webhook no painel · comprar o domínio · publicar Termos e Privacidade ·
fazer o teste com dinheiro real

**Programador:**
adaptar `CATALOG` e a UI · subir Postgres e trocar o import · `npm i pg
nodemailer` · configurar SMTP (`SMTP_URL`, `MAIL_FROM`, `ORG_NAME`) ·
deploy com HTTPS · alerta sobre `[email] ALERTA`

Se a chave `sk_live_` alguma vez foi partilhada por chat, e-mail ou
mensagem — revogar e gerar outra antes de qualquer deploy.
