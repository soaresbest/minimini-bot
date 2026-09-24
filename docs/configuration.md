# Configuração

Na primeira execução em um terminal, o programa pergunta o servidor e a porta, consulta o status desse servidor e sugere a versão detectada. Depois pergunta o nome do primeiro bot, a autenticação e o modo inicial. A integração com IA é opcional. `npm run configure` abre o assistente novamente, preservando os outros bots e as preferências já salvas. O assistente mostra cada consulta e o destino antes de salvar.

O arquivo fica na home do usuário que executa o programa:

- Windows: `%USERPROFILE%\.minimini-bot\config.json`.
- Linux e macOS: `~/.minimini-bot/config.json`.

`MINIMINI_CONFIG` permite escolher outro arquivo. Caminhos relativos usam o diretório atual. Em execução sem terminal interativo, prepare o arquivo antes: o programa informa como configurar e encerra se ele estiver ausente, sem ficar esperando entrada.

```json
{
  "schemaVersion": 1,
  "server": {
    "host": "localhost",
    "port": 25565,
    "version": "1.21.11",
    "registration": true
  },
  "bots": [
    {
      "name": "bot1",
      "username": "bot1",
      "auth": "offline",
      "mode": "default"
    }
  ],
  "llm": {
    "provider": "openai",
    "providers": {
      "openai": { "model": "gpt-4.1-mini" },
      "gemini": { "model": "gemini-2.5-flash" },
      "grok": { "model": "grok-4.7" },
      "claude": { "model": "claude-haiku-4-5" }
    }
  },
  "access": {
    "allowedPlayers": [],
    "ignoredPlayers": []
  },
  "settings": {
    "maxBots": 8,
    "progressIntervalMs": 15000,
    "reconnectDelayMs": 5000,
    "commandCooldownMs": 1000,
    "actionTimeoutMs": 120000,
    "autoEatAt": 16
  },
  "registrations": {
    "localhost:25565": {
      "bot1": "00123456"
    }
  }
}
```

`server.host` recebe somente hostname ou IP; a porta fica em `server.port`. IPv6 é aceito com ou sem colchetes. `server.version` guarda a versão exata detectada, incluindo o formato atual como `26.2`. O valor legado `"auto"` continua aceito: na próxima inicialização o programa consulta o protocolo, grava a versão explícita no arquivo e só então conecta. Se a versão for conhecida, mas os dados dela ainda não estiverem disponíveis nas dependências instaladas, o terminal informa a versão mais recente disponível. Ela pode ser escolhida em `npm run configure` quando o servidor aceitar clientes antigos; nos demais casos, atualize a branch `main` antes de executar novamente o instalador quando o suporte for publicado. O projeto conecta a servidores Minecraft Java.

`server.registration: true` habilita autenticação automática em plugins que usam `/register` e `/login`. Na primeira conexão, o programa gera uma senha aleatória de exatamente 8 dígitos, salva a configuração e somente depois envia `/register senha senha`, seguido de `/login senha`. Nas próximas conexões, reutiliza a senha salva. `registrations` separa as credenciais pelo endereço e porta do servidor e pelo campo `name` de cada bot. O exemplo `00123456` é fictício; não reutilize senhas reais nessa documentação. Para servidores sem esse plugin, defina `registration: false` ou responda `n` no assistente.

`name` é o nome usado em menções, como `@bot1 status`, e deve ter de 1 a 16 letras, números ou `_`. Os nomes são únicos, sem diferenciar maiúsculas de minúsculas. `username` é o usuário usado na conexão. Em autenticação `offline`, ele pode ser omitido e recebe o mesmo valor de `name`; esse modo depende de o servidor aceitar autenticação offline.

Para autenticação `microsoft`, informe em `username` o e-mail/identificador da conta Microsoft que possui Minecraft Java. O nome `name` continua sendo o identificador do bot nos comandos e não altera o nome do perfil Minecraft da conta. O login por código é solicitado na conexão. Cada bot precisa de uma conta diferente em servidores autenticados. Dados de autenticação ficam fora do repositório.

## IA e chaves

Cada bot pode informar `provider` e `model` para substituir os padrões de `llm`. Os identificadores dos provedores são `openai` (ChatGPT/OpenAI), `gemini` (Google), `grok` (xAI) e `claude` (Anthropic). Os modelos são configuráveis: disponibilidade e acesso dependem da conta do provedor.

Informe `apiKey` dentro da configuração do provedor ou use a variável de ambiente correspondente:

| Provedor | Variável |
| --- | --- |
| `openai` | `OPENAI_API_KEY` |
| `gemini` | `GEMINI_API_KEY` |
| `grok` | `XAI_API_KEY` |
| `claude` | `ANTHROPIC_API_KEY` |

O assistente oculta a digitação da chave. Enter mantém a chave já salva; `-` remove a chave do arquivo. Chaves fornecidas por variável de ambiente não são copiadas para o arquivo. O modo `ia` exige uma chave disponível para o provedor escolhido. `npm run configure` permite corrigir a chave mesmo quando a configuração existente tem bots em modo IA sem credenciais disponíveis.

O JSON pode conter chaves de IA e senhas de `/register` em texto simples. Não o compartilhe nem o coloque no Git. A escrita é atômica. Em Linux/macOS, o arquivo é criado com permissão `0600` e o diretório padrão com `0700`. Um diretório novo de um caminho personalizado também é criado com `0700`; as permissões de diretórios personalizados já existentes são preservadas. No Windows, proteja a pasta com as permissões da sua conta. Um arquivo com JSON inválido não é sobrescrito pelo programa: corrija-o ou mova-o para um backup.

## Acesso e sobrevivência

`allowedPlayers: []` permite comandos de todos os jogadores. Para restringir, preencha a lista com os nomes autorizados. `ignoredPlayers` contém nomes que nunca podem comandar os bots e pode incluir bots externos conhecidos. Nomes são comparados sem diferenciar maiúsculas de minúsculas. No assistente, `*` limpa a lista de autorizados e `-` limpa a lista de ignorados.

Os bots gerenciados por este processo são ignorados automaticamente. O protocolo Minecraft não identifica de forma confiável se outra conexão é humana ou automatizada; use as listas de acesso para controlar bots externos.

`maxBots` limita o total configurado, com padrão de 8 e intervalo de 1 a 64. `progressIntervalMs` controla a frequência de mensagens de progresso; `reconnectDelayMs`, a espera entre tentativas de reconexão; `commandCooldownMs`, o intervalo mínimo entre comandos; e `actionTimeoutMs`, o limite das ações finitas. Esses tempos são em milissegundos. `autoEatAt` é o limiar de fome entre 0 e 20 que aciona a tentativa de alimentação automática quando houver comida adequada no inventário. A sobrevivência continua ativa nos dois modos.
