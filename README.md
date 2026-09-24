# minimini-bot

[![Verificações](https://github.com/soaresbest/minimini-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/soaresbest/minimini-bot/actions/workflows/ci.yml)

Bots para **Minecraft Java Edition**, em **Node.js 24 + Mineflayer**, controlados pelos jogadores no chat. Cada bot pode operar com comandos diretos ou interpretar pedidos usando OpenAI/ChatGPT, Gemini, Grok ou Claude.

## Instalar e iniciar

1. [Baixe o ZIP da main](https://github.com/soaresbest/minimini-bot/archive/refs/heads/main.zip) e extraia a pasta inteira.
2. **Windows:** abra `install.cmd`, que executa o instalador PowerShell. **Linux/macOS:** abra o terminal na pasta e execute `bash install.sh`. No macOS também existe `install.command`.
3. Confirme as etapas no terminal. O instalador verifica o ambiente, prepara Node.js 24, instala as dependências e oferece iniciar o programa.
4. Informe o servidor, porta, nome do bot e tipo de autenticação. O assistente consulta o servidor, mostra o protocolo e salva a versão detectada. Configure a IA agora ou depois. O assistente só aparece automaticamente quando o arquivo de configuração ainda não existe.

Não é necessário instalar Node.js ou Git antes. Se precisar, o instalador baixa o Node.js oficial na pasta do usuário e verifica SHA-256. No Linux mínimo, oferece instalar ferramentas/bibliotecas pelo gerenciador de pacotes. O projeto não contém dependências nativas que exijam compilador.

Para executar novamente, use **`start.cmd`** no Windows ou **`bash start.sh`** no Linux/macOS. Mantenha o terminal aberto; `Ctrl+C` encerra todos os bots.

O instalador atende Windows 10+/Server 2016+, macOS 13.5+ e Linux com glibc 2.28+, em x64/arm64. Requisitos completos, opções de automação e diagnóstico: [instalação](docs/installation.md).

Se Node.js 24 já estiver disponível:

```bash
npm ci
npm start
```

## Comandos no Minecraft

Somente mensagens com uma menção completa, como `@bot1`, ativam o bot. Os nomes não diferenciam maiúsculas de minúsculas; `@bot10` não ativa `bot1`. Não é necessário usar `/`.

| Mensagem de exemplo | Resultado |
| --- | --- |
| `@bot1 goto(100,60,300)` | Caminha até perto da posição indicada. |
| `@bot1 follow(Steve)` | Valida se Steve está conectado e começa a segui-lo. |
| `@bot1 guard(Steve)` | Segue e protege Steve, equipando uma arma disponível. |
| `@bot1 stop` | Cancela o pedido de IA e a tarefa atual, parando no local. |
| `@bot1 status` | Informa vida, fome, tarefa, modo e inventário. |
| `@bot1 help` | Mostra os comandos. |
| `@bot1 mode(ia)` | Ativa IA, exigindo a chave do provedor configurado. |
| `@bot1 mode(default)` | Volta aos comandos diretos. |

O bot confirma o recebimento, mas só informa seu estado completo quando recebe `status`. A única exceção automática é um alerta quando vida ou fome chegam a `8/20` ou menos e não há comida segura no inventário. Comandos desconhecidos no modo simples recebem `Não entendi. Use help.`. Consultar `status` ou `help` preserva a tarefa atual. Um novo comando de ação substitui a tarefa anterior; `stop` cancela imediatamente.

Em servidores com plugin de autenticação, `server.registration: true` faz cada bot gerar uma senha aleatória de 8 dígitos na primeira conexão. A senha é salva por servidor e nome do bot em `~/.minimini-bot/config.json` antes do envio de `/register senha senha`; nas reconexões, o bot reutiliza a mesma senha com `/login senha`. A senha nunca aparece nos logs nem nas respostas normais do bot. Desative essa opção em servidores sem `/register`.

`goto` usa caminhos sem quebrar ou colocar blocos automaticamente. Destinos impossíveis ou demorados geram uma resposta de falha. `follow` e `guard` são contínuos: um jogador conectado fora da distância de renderização será aguardado; se ele desconectar, o bot para. Esses comandos não teleportam entre dimensões.

`guard` enfrenta mobs hostis a até 8 blocos do protegido e limita a perseguição a 16 blocos do bot. Nas versões que informam o autor do dano, também reage por até 10 segundos a um agressor identificado pelo servidor, inclusive um jogador. Jogadores próximos não são atacados apenas por estarem perto. Em protocolos antigos sem identificação do agressor, permanece a proteção contra mobs hostis. Bots gerenciados não são escolhidos como agressores. Sem arma no inventário, usa a mão.

## Vários bots pelo chat

Cada bot conectado pode receber comandos de gerenciamento:

```text
@bot1 bots
@bot1 botadd(bot2)
@bot1 botadd(bot3,ia,gemini)
@bot1 botconfig(bot2,provider,claude)
@bot1 botconfig(bot2,model,claude-haiku-4-5)
@bot1 botconfig(bot2,mode,ia)
@bot1 botremove(bot3)
```

As alterações são validadas e salvas na home antes de serem aplicadas. Bots criados voltam a conectar na próxima execução; bots removidos saem da configuração. O limite inicial é de 8 bots e pode ser ajustado em `settings.maxBots`. O último bot é preservado para que continue existindo um canal de gerenciamento no jogo.

`botadd` cria contas **offline**, para servidores que aceitam esse tipo de autenticação. Em servidores com autenticação Microsoft, cada bot precisa de uma conta própria com Minecraft Java: cadastre as contas na lista `bots` do arquivo pessoal e reinicie. O login por código aparece no terminal. E-mails, senhas e chaves nunca são configurados pelo chat. O nome usado em `@menções` pode ser um alias; a conexão Microsoft usa o nome real da conta.

Por padrão, todos os jogadores conectados podem dar comandos. `access.allowedPlayers` restringe esse acesso e `access.ignoredPlayers` ignora nomes adicionais. Bots desta aplicação são ignorados como autores de comandos, evitando ciclos de conversa. O protocolo não permite reconhecer automaticamente qualquer bot de terceiros: cadastre seus nomes em `ignoredPlayers` ou use uma lista de jogadores autorizados.

## Configuração e IA

A configuração padrão fica em **`~/.minimini-bot/config.json`**, inclusive no Windows (`%USERPROFILE%\.minimini-bot\config.json`). Para revisar a conexão e configurar um provedor:

```bash
npm run configure
```

Quem usa o runtime instalado pode executar `bash start.sh --configure` ou `start.cmd --configure`. A chave digitada no assistente fica oculta no terminal. Também são aceitas `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY` e `ANTHROPIC_API_KEY`, com prioridade sobre as chaves salvas. Modelos e provedores podem ser diferentes por bot.

```text
@bot1 mode(ia)
@bot1 venha até mim e me proteja
@bot1 vá para 100, 64, 300 e depois informe seu inventário
@bot1 equipe a espada de ferro
@bot1 mode(default)
```

Comandos diretos continuam disponíveis no modo IA, especialmente `stop`. Pedidos em linguagem natural enviam à API a mensagem, o catálogo de ações e um resumo limitado do estado do bot: posição, dimensão, tarefa, vida, fome, saturação, oxigênio, item equipado, inventário, jogadores conectados, entidades próximas e blocos carregados que estejam em linha de visão. O modelo devolve uma resposta e até 8 ações. O plano inteiro é validado antes de executar: movimento, seguir, proteger, parar, consultar estado, equipar, olhar, minerar, colocar blocos e esperar. O programa não executa código JavaScript produzido pela IA.

As APIs exigem chaves próprias e podem cobrar por uso. Modelos e disponibilidade dependem da conta. Cada consulta tem limite de 30 segundos e pode ser cancelada por outro comando. Os resultados das ações são informados no chat; não há replanejamento autônomo nem memória persistente de conversa.

Consulte [configuração detalhada](docs/configuration.md) e [integrações de IA, ações e fontes oficiais](docs/ai.md).

## Sobrevivência e conexão

Todos os bots, em qualquer modo, comem automaticamente quando a fome chega ao limite configurado, se houver alimento seguro no inventário. A alimentação pausa o movimento e retoma a tarefa; se receber `stop` durante a refeição, permanece parado depois. Sem comida segura, o bot alerta somente quando a fome ou a vida chega a `8/20` ou menos, repetindo no máximo uma vez por minuto enquanto o risco continuar. Entregue alimentos e armas pelo inventário normal do Minecraft.

O bot evita alimentos prejudiciais/teletransporte e caminhos que exigem alterar o terreno. Isso não garante sobrevivência a todos os perigos, nem implementa coleta autônoma de recursos. Ao morrer, cancela a tarefa e aguarda o respawn do servidor. Falhas de conexão iniciam novas tentativas com intervalo crescente; remover um bot ou encerrar o programa cancela essas tentativas.

O bootstrap consulta o status do servidor e grava a versão em `server.version`. Configurações antigas com `"auto"` são detectadas e atualizadas antes da conexão. Se o servidor usar uma versão ainda sem dados publicados para o Mineflayer, o programa mostra a versão mais recente disponível e encerra em vez de repetir tentativas incompatíveis. Se o servidor aceitar clientes antigos por um plugin de compatibilidade, essa versão pode ser informada em `npm run configure`; caso contrário, atualize a branch `main` e execute novamente o instalador quando o suporte for publicado. Servidores com plugins de chat, login, whitelist ou anticheat podem exigir ajustes próprios. Minecraft Bedrock não é atendido por este projeto.

## Desenvolvimento e verificação

### Executar com F5 no Visual Studio Code

Abra a pasta raiz do projeto no Visual Studio Code e pressione **F5**. A configuração `Minimini Bot` faz o seguinte automaticamente:

1. abre um terminal integrado para mostrar a preparação;
2. procura uma instalação válida do Node.js 24, usando primeiro o runtime local do projeto;
3. executa o instalador completo do sistema se o Node.js 24 não estiver disponível;
4. verifica a árvore inteira de dependências e executa `npm ci` somente quando ela estiver ausente, inválida ou desatualizada;
5. inicia `src/index.js` com o depurador no terminal integrado do próprio VS Code.

Na primeira execução do bot, o mesmo terminal integrado solicita servidor, porta, nome e autenticação. Pontos de interrupção, pausa, inspeção de variáveis e reinício funcionam normalmente pelo depurador. Encerre com `Shift+F5` ou `Ctrl+C` no terminal. Não é necessário instalar extensões adicionais do VS Code.

```bash
npm ci --ignore-scripts
npm run verify
npm audit
```

Os testes cobrem comandos, configuração, persistência, exclusão de bots, concorrência, cancelamento, sobrevivência, quatro provedores com HTTP simulado e instaladores. Há um teste de conexão real do Mineflayer com um servidor de protocolo local; ele verifica login/chat e não substitui uma sessão em um mundo Minecraft completo. As chamadas de IA nos testes não usam créditos. O GitHub Actions executa a suíte em Windows, Ubuntu e macOS.

Arquitetura: `src/config.js` prepara e persiste configurações; `src/manager.js` gerencia conexões e chat; `src/controller.js` executa ações e sobrevivência; `src/ai/planner.js` integra as APIs. Scripts de instalação e inicialização ficam na raiz. Dados pessoais e sessões ficam fora do Git.

As alterações do projeto são mantidas na branch **`main`**, com commits e push após as verificações de cada mudança concluída. A atualização de uma instalação existente é descrita no [guia de instalação](docs/installation.md).
