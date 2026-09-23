import { loadConfig, saveConfig, configPath } from './config.js';
import { BotManager } from './manager.js';
import { resolveServerVersion } from './server-version.js';

async function main() {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Este projeto requer Node.js 24. Execute o instalador do seu sistema.');
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('minimini-bot\n  npm start             Iniciar os bots\n  npm run configure     Configurar conexão e IA\n  npm start -- --check-config  Validar configuração sem conectar\nConfiguração: ' + configPath());
    return;
  }
  if (args.some(a => !['--configure', '--check-config'].includes(a))) throw new Error('Opção desconhecida. Use --help.');
  let config = await loadConfig({ configure: args.includes('--configure') });
  if (args.includes('--configure') || args.includes('--check-config')) { console.log(`Configuração válida: ${configPath()}`); return; }
  config = await resolveServerVersion(config, { save: saveConfig });
  console.log(`Configuração carregada: ${configPath()}`);
  console.log('Use Ctrl+C para encerrar. Comandos no Minecraft: @nomeDoBot help');
  const manager = new BotManager(config);
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    console.log('\nEncerrando bots...');
    manager.close();
    const timer = setTimeout(() => process.exit(0), 1500);
    timer.unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  manager.start();
}

main().catch(error => { console.error(`Erro: ${error.message}`); process.exitCode = 1; });
