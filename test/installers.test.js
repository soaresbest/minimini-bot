import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const unix = process.platform !== 'win32';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'minimini installer '));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync(join(root, 'install.sh'), join(directory, 'install.sh'));
  mkdirSync(join(directory, 'scripts'));
  cpSync(join(root, 'scripts/runtime.sh'), join(directory, 'scripts/runtime.sh'));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'installer-fixture', version: '1.0.0', private: true }));
  writeFileSync(join(directory, 'package-lock.json'), JSON.stringify({ name: 'installer-fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'installer-fixture', version: '1.0.0' } } }));
  return directory;
}

function bash(script, args = [], options = {}) {
  return spawnSync('bash', ['-c', script, 'installer-test', ...args], {
    cwd: root, encoding: 'utf8', timeout: 30_000, ...options,
  });
}

test('instalador Bash aceita cancelamento antes de modificar o projeto', { skip: !unix }, (t) => {
  const directory = fixture(t);
  const result = spawnSync('bash', ['install.sh'], { cwd: directory, input: 'n\n', encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Etapa 1\/4/);
  assert.doesNotMatch(result.stdout, /Etapa 2\/4/);
  assert.equal(existsSync(join(directory, 'node_modules')), false);
});

test('instalador Bash prepara projeto com espaços no caminho sem iniciar o bot', { skip: !unix }, (t) => {
  const directory = fixture(t);
  const result = spawnSync('bash', ['install.sh', '--yes', '--no-start'], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /reutilizar Node\.js v24\./);
  assert.match(result.stdout, /Dependências instaladas/);
  assert.match(result.stdout, /inicialização adiada/);
});

test('instalador Windows prepara projeto com espaços no caminho sem iniciar o bot', { skip: process.platform !== 'win32' }, (t) => {
  const directory = fixture(t);
  cpSync(join(root, 'install.ps1'), join(directory, 'install.ps1'));
  cpSync(join(root, 'scripts/runtime.ps1'), join(directory, 'scripts/runtime.ps1'));
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(directory, 'install.ps1'), '-Yes', '-NoStart'], {
    cwd: directory, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /reutilizar Node\.js v24\./);
  assert.match(result.stdout, /Etapa 4\/4/);
});

test('instalador Bash recusa musl antes de baixar ou instalar Node', { skip: !unix }, (t) => {
  const directory = fixture(t);
  const fakeBin = join(directory, 'fake-bin');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n', { mode: 0o755 });
  writeFileSync(join(fakeBin, 'getconf'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const result = spawnSync('bash', ['install.sh', '--yes', '--no-start'], { cwd: directory, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Alpine\/musl/);
  assert.doesNotMatch(result.stdout, /Baixando/);
});

test('verificação SHA-256 aceita arquivo íntegro e recusa corrupção', { skip: !unix }, (t) => {
  const directory = fixture(t);
  const archive = join(directory, 'arquivo com espaços.tar.gz');
  const data = Buffer.from('conteúdo esperado');
  const hash = createHash('sha256').update(data).digest('hex');
  writeFileSync(archive, data);
  const command = 'source scripts/runtime.sh; minimini_verify_checksum "$1" "$2"';
  assert.equal(bash(command, [archive, hash]).status, 0);
  writeFileSync(archive, 'arquivo alterado');
  assert.equal(bash(command, [archive, hash]).status, 1);
});

test('runtime recusa executável de outra versão do Node', { skip: !unix }, (t) => {
  const directory = fixture(t);
  const executable = join(directory, 'node');
  writeFileSync(executable, '#!/bin/sh\necho v26.0.0\n', { mode: 0o755 });
  assert.equal(bash('source scripts/runtime.sh; minimini_node24 "$1"', [executable]).status, 1);
});

test('scripts Bash são sintaticamente válidos', { skip: !unix }, () => {
  for (const script of ['install.sh', 'start.sh', 'install.command', 'start.command', 'scripts/runtime.sh']) {
    const result = spawnSync('bash', ['-n', join(root, script)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
});

const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const hasPowerShell = spawnSync(powershell, ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' }).status === 0;
test('scripts PowerShell são sintaticamente válidos', { skip: !hasPowerShell }, () => {
  const result = spawnSync(powershell, ['-NoProfile', '-Command', `
    $failed = $false
    foreach ($path in @('install.ps1', 'start.ps1', 'scripts/runtime.ps1')) {
      $tokens = $null
      $parseErrors = $null
      [System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) $path), [ref]$tokens, [ref]$parseErrors) | Out-Null
      if ($parseErrors.Count -gt 0) { $parseErrors | Out-String | Write-Output; $failed = $true }
    }
    if ($failed) { exit 1 }
  `], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('PowerShell preserva mensagens UTF-8 no Windows PowerShell 5.1', () => {
  for (const script of ['install.ps1', 'start.ps1', 'scripts/runtime.ps1']) {
    assert.deepEqual(readFileSync(join(root, script)).subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  }
});
