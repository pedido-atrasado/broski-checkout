// Gera broski-checkout.zip so com o que deve viajar.
// Lista EXPLICITA de ficheiros — nao apanha node_modules, data/ nem .env
// por construcao, sem depender de ninguem se lembrar de os excluir.
//
//   node scripts/empacotar.js
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const RAIZ = path.resolve(import.meta.dirname, '..');
const DESTINO = path.resolve(RAIZ, '..', 'broski-checkout.zip');

const INCLUIR = [
  '.env.example', '.gitignore', 'ENTREGA.md', 'README.md', 'package.json',
  'server.js',
  'lib/broski.js', 'lib/mailer.js', 'lib/store.js', 'lib/store.pg.js', 'lib/webhook.js',
  'public/index.html',
  'scripts/empacotar.js',
  'test/e2e.js', 'test/mailer.test.js', 'test/mock-broski.js', 'test/store.test.js', 'test/webhook.test.js',
];

const PROIBIDO = [/^node_modules\//, /^data\//, /^\.env$/, /\.log$/, /^\.git\//];

const emFalta = INCLUIR.filter((f) => !fs.existsSync(path.join(RAIZ, f)));
if (emFalta.length) {
  console.error('Ficheiros em falta:', emFalta.join(', '));
  process.exit(1);
}
const proibidos = INCLUIR.filter((f) => PROIBIDO.some((r) => r.test(f)));
if (proibidos.length) {
  console.error('Ficheiros que nunca podem ir no zip:', proibidos.join(', '));
  process.exit(1);
}

fs.rmSync(DESTINO, { force: true });

// PowerShell nao respeita .gitignore; o zipfile do Python leva lista explicita.
const py = INCLUIR.map((f) => JSON.stringify(f)).join(', ');
const script = `
import zipfile, os
files = [${py}]
raiz = ${JSON.stringify(RAIZ)}
with zipfile.ZipFile(${JSON.stringify(DESTINO)}, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.write(os.path.join(raiz, f.replace('/', os.sep)), 'broski-checkout/' + f)
print(len(files))
`;
const n = execFileSync('python', ['-c', script], { encoding: 'utf8' }).trim();

const kb = (fs.statSync(DESTINO).size / 1024).toFixed(1);
console.log(`${DESTINO}\n${n} ficheiros, ${kb} KB`);
console.log('Sem node_modules, sem data/, sem .env — por construção.');
