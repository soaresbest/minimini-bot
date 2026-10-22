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
| `@bot1 railway(Alex)` | Constrói trilhos da posição atual do bot até o jogador, usando apenas o inventário. |
| `@bot1 railway(0,64,0,100,70,0,false)` | Constrói trilhos entre as duas posições usando apenas o inventário. |
| `@bot1 railway(0,64,0,100,70,0,true)` | Faz a mesma obra e pode usar `/give` para repor os blocos permitidos. |
| `@bot1 stop` | Cancela o pedido de IA e a tarefa atual, parando no local. |
| `@bot1 status` | Informa vida, fome, tarefa, modo e inventário. |
| `@bot1 help` | Mostra os comandos. |
| `@bot1 mode(ia)` | Ativa IA, exigindo a chave do provedor configurado. |
| `@bot1 mode(default)` | Volta aos comandos diretos. |

O bot confirma o recebimento, mas só informa seu estado completo quando recebe `status`. A única exceção automática é um alerta quando vida ou fome chegam a `8/20` ou menos e não há comida segura no inventário. Comandos desconhecidos no modo simples recebem `Não entendi. Use help.`. Consultar `status` ou `help` preserva a tarefa atual. Um novo comando de ação substitui a tarefa anterior; `stop` cancela imediatamente.

Em servidores com plugin de autenticação, `server.registration: true` faz cada bot gerar uma senha aleatória de 8 dígitos na primeira conexão. A senha é salva por servidor e nome do bot em `~/.minimini-bot/config.json` antes do envio de `/register senha senha`; nas reconexões, o bot reutiliza a mesma senha com `/login senha`. A senha nunca aparece nos logs nem nas respostas normais do bot. Desative essa opção em servidores sem `/register`.

`goto` usa caminhos sem quebrar ou colocar blocos automaticamente. Destinos impossíveis ou que excedam o limite de tempo de navegação geram uma resposta de falha; isso também vale para deslocamentos durante a construção de trilhos. `follow` e `guard` são contínuos: um jogador conectado fora da distância de renderização será aguardado; se ele desconectar, o bot para. Esses comandos não teleportam entre dimensões.

`@bot1 railclear(Steve)` inicia a limpeza contínua durante a viagem: os comandos passam pela mesma fila das mensagens, com intervalo de 1,1 segundo entre envios, sem rajadas. Uma varredura dos dez pontos leva cerca de 11 segundos (mais se houver mensagens na fila). O servidor verifica entidades vivas a até 16 blocos de Steve e usa `/kill` nas que estão sobre trilhos ou a um bloco deles nos quatro lados. Reconhece todos os tipos da tag `minecraft:rails`, na altura dos pés ou um bloco abaixo. Remove também animais, pets e aldeões nessa faixa; preserva jogadores, carrinhos, itens e suportes de armadura. O bot precisa de permissão para `/execute` e `/kill`; mensagens de erro do servidor indicam falta de permissão. O comando acompanha a posição e dimensão do jogador no servidor, mesmo fora do alcance visual do bot, sem precisar seguir o carrinho. Funciona nos chunks carregados pelo jogador. `@bot1 stop`, outra tarefa, desconexão do jogador, morte ou desconexão do bot encerram a limpeza. Não reinicia um carrinho já parado e não garante ausência de colisões entre verificações. Disponível como comando direto nos modos default e IA; a IA não pode gerar essa ação automaticamente. Não exige dependências ou alterações nos instaladores Windows, Linux e macOS.

`railway(player)` recebe o nome de um jogador conectado e visível para o bot, por exemplo `@bot1 railway(Alex)`. Constrói da posição atual do bot até a posição do jogador no início da execução, sem acompanhar movimentos posteriores e sem autorizar `/give`. Os aliases `trilho(player)` e `trilhos(player)` também são aceitos. Jogadores desconectados, fora do alcance visível e outros bots são rejeitados antes de iniciar a obra.

`railway(x1,y1,z1,x2,y2,z2,permissão)` (ou os aliases `trilho` e `trilhos`) recebe as posições dos blocos de trilho. Qualquer uma das seis coordenadas pode ser um inteiro ou `~`. Em X/Z e na altura inicial, `~` usa a coordenada atual do bot; no Y final, permite chegar na altura encontrada pelo planejamento do terreno. A permissão aceita **somente** `true`, para autorizar `/give`, ou `false`, para usar apenas o inventário. Exemplos: `@bot1 railway(-1999,~,20,2000,~,20,true)` e `@bot1 railway(~,~,~,2000,~,~,false)`. Sem permissão, a tarefa para e avisa no chat assim que faltar `rail`, `powered_rail`, `redstone_block` ou `stone`. Com permissão, somente esses quatro identificadores fixos podem ser solicitados; o bot precisa ter autorização do servidor para `/give`. Se a sintaxe estiver incorreta, o bot mostra o formato correto sem consultar a IA.

A ferrovia começa com trilho eletrificado sobre bloco de redstone. O planejamento A* usa somente chunks carregados, considera os próximos 64 blocos e constrói/revalida lotes de até 12 posições. Mantém o desvio planejado até perto do fim, quando recalcula preservando a orientação da próxima posição. Cada trecho intermediário precisa terminar com uma continuação viável; o destino final pode ser um beco. O trajeto acompanha o piso, com subidas e descidas de no máximo um bloco por posição. Diante de um degrau maior ou paredão, busca um desvio ou uma rampa natural pelos quatro pontos cardeais, primeiro em 64 e depois em 96 blocos ao redor. A busca ampliada examina até 120 mil nós em pequenas etapas, liberando o processamento de pacotes do servidor e de `stop` durante o cálculo. O cache de blocos é limpo após cada pausa para reler alterações do mundo. Os logs distinguem limite de busca de rotas esgotadas. Se a busca ampliada falhar, pode ajustar a saída reservada somente do último trilho comum da própria obra, mantendo as regras de geometria e os bloqueios. Para montanhas mais largas que a janela de busca, o bot avança lateralmente por trechos, conserva o lado escolhido e procura uma passagem para o outro lado a cada recálculo. Assim, o contorno pode continuar por centenas de blocos conforme novos chunks entram no alcance, sem subir artificialmente pelos paredões nem reutilizar colunas construídas. Com horizonte parcialmente descarregado ou limite de busca atingido, pode reduzir o progresso local para 32 blocos; cada posição construída ainda precisa estar carregada e ter piso válido. O contorno depende de existir uma continuação segura no terreno e não garante passagem por obstáculos fechados. Se ainda não encontrar uma rota, interrompe a tarefa com um aviso. Quando faltar apoio em um bloco de ar carregado, estende um piso de pedra na mesma altura antes de colocar os trilhos; nos pontos eletrificados, usa bloco de redstone como piso para manter a alimentação. Prefere piso existente e não cria subidas artificiais para vencer paredões. A colocação precisa de uma face sólida de referência, aproveitando o apoio do trecho anterior. A busca prefere o piso existente, penaliza travessias artificiais e impede repetir colunas tanto no próprio plano quanto nos trechos já construídos. O trilho da curva permanece plano, inclusive no topo de rampas com vizinhos um bloco abaixo. O corredor recebe três blocos de altura livre. Água ou lava na superfície do piso são substituídas por pedra, ou redstone sob trilhos eletrificados; o trilho fica acima do líquido, com o corredor sem líquidos internos ou adjacentes. O bot também evita remover tetos que sustentam água ou lava, para não inundar o trajeto. A distribuição de impulso é recalculada em cada trecho: os intervalos pretendidos são oito posições entre pontos de alimentação no plano e três perto de rampas; curvas comuns podem adiar a alimentação até uma posição compatível com a geometria. Após uma curva, a primeira posição reta recebe um ponto extra de alimentação com trilho eletrificado sobre redstone, também nas descidas e após retomadas. Curvas consecutivas permanecem com trilhos comuns até essa posição. O intervalo normal de alimentação passa a contar desse novo ponto. Todo trilho eletrificado fica sobre redstone. `stop` cancela a construção.

Quando o destino tem uma altura definida abaixo do trecho atual, o `railway` pode planejar uma **descida artificial sobre ar carregado**, com no máximo um bloco de desnível por posição horizontal. Para destinos próximos com grande desnível, tenta primeiro corredores retos ou com desvios laterais e patamares nas curvas, evitando esgotar o A* nas combinações de altura. Se não encontrar um corredor válido, mantém a busca normal pelo terreno. Com Y final `~`, continua acompanhando a altura do terreno, sem inventar uma altura de chegada. A geometria das curvas continua validada pelo planejador; se faltar espaço horizontal, terreno carregado ou uma rota compatível, a tarefa informa a falha.

Cada sequência descendente é construída **de baixo para cima**, mesmo que ultrapasse o lote normal de 12 blocos: primeiro prepara todos os pisos, depois instala os trilhos da base até o encontro com o trecho alto. Usa pedra nos apoios comuns e redstone sob os trilhos energizados, calculando a alimentação na ordem original do trajeto (intervalo de três posições nas rampas, oito no plano, respeitando curvas e extremidades). A areia existente continua preservada sob trilhos comuns. Pedras adicionais ligam lateralmente os pisos de degraus consecutivos. Se a base não tiver face de apoio, procura chão sólido carregado abaixo e constrói uma coluna de pedra a partir dele; não assume que chunks desconhecidos sejam vazios. Todos esses blocos consomem inventário, com `/give` somente quando autorizado no comando.

O bot se aproxima da base e sobe conforme prepara os apoios. Pode usar `/tp` diretamente para um apoio vizinho carregado com piso sólido e espaço livre, incluindo os degraus já preparados; isso exige permissão de teleporte no servidor. Quando não encontra essa posição, tenta a navegação normal. Se estiver ocupando o espaço de um apoio, desloca-se antes de colocá-lo. A retomada salva separadamente a etapa de apoios, a etapa de trilhos e as células já construídas, sem repetir os trechos concluídos após reconectar. O plano da descida e a etapa pendente também entram nos diagnósticos persistentes.

Pisos incompatíveis com trilhos (incluindo `grass_path`/`dirt_path`, terra arada, lajes inferiores, neve fina e folhas) são substituídos por pedra no mesmo nível, ou redstone nos pontos eletrificados. A decisão considera o formato e o estado do apoio, não só uma lista de nomes; apoios compatíveis são preservados. Se o servidor recusar um trilho sobre um piso aparentemente válido, o bot tenta normalizar esse piso uma vez. Material é verificado antes da escavação. O Y inicial automático também considera a altura fracionária de pisos como grass path.

Antes de colocar trilhos comuns, o bot preserva pisos de areia e areia vermelha, inclusive se o servidor recusar a colocação do trilho; nesse caso, informa a falha sem trocar a areia por pedra. Cascalho e pó de concreto continuam sendo substituídos por pedra para que o piso não caia com a atualização dos blocos. Nos pontos de trilho energizado, o piso ainda é substituído por redstone para alimentação. Se já houver um trilho sobre o piso a substituir, remove-o primeiro e recoloca o trilho após confirmar o novo apoio. Ao trocar o apoio lateral alto de uma rampa, preserva e recoloca o trilho anterior, aguarda as atualizações do servidor e confirma que ele permaneceu no lugar, com até três tentativas.

Para colocar pedra ou redstone, o bot prefere a face sólida do piso anterior e aproveita outros blocos sólidos ao redor, inclusive areia submersa. Se não houver face adjacente, busca uma conexão com até três pedras através de ar ou líquido, no nível do piso ou abaixo, preservando o corredor e os trilhos concluídos. Essas pedras permanecem como parte do piso. Ao substituir um bloco sólido isolado por redstone, cria um apoio temporário e só o remove depois de confirmar a substituição. Se ainda não encontrar apoio, interrompe a tarefa.

A navegação habilita `Movements.canDig` e usa os IDs de itens `dirt`, `cobblestone` e `stone` em `scafoldingBlocks` (grafia da API instalada). O pathfinder recebe `thinkTimeout = 25000` ms, mantendo fatias de processamento de 40 ms para atender aos eventos do servidor. A versão instalada não suporta `maxSteps`; no planejador próprio que emite `RAILWAY_NO_ROUTE`, a busca inicial foi ampliada para **25 mil estados**, mantendo a busca ampliada de 120 mil estados. A aproximação de destinos distantes, inclusive do início da obra, usa checkpoints de até 64 blocos, navegando até cada um antes de ativar o próximo. Isso permite carregar chunks gradualmente; não garante rota quando não houver passagem possível. O planejamento dos trilhos continua validando o terreno por trechos.

Pontes e andaimes de navegação estão habilitados para todos os bots, incluindo `soaresbot8`: o pathfinder pode preencher buracos de `air`, `cave_air` e `void_air` e subir colocando blocos sob os pés (`allow1by1towers = true`). Usa terra, pedregulho ou pedra disponíveis no inventário; a pedra fornecida ao `railway` também pode ser consumida pela navegação. Isso não concede permissões no servidor nem fornece material automaticamente ao pathfinder. É necessário ter blocos no inventário e permissão de construção na região. O traçado dos trilhos mantém suas regras de rampas e apoios.

Durante a aproximação (`aproximando`) de uma tarefa `railway`, se o bot ficar mais de 2 segundos sem se mover (deslocamentos menores que 0,1 bloco são ignorados) ou levar mais de 10 segundos para chegar, ele interrompe a caminhada e envia `/tp` para se posicionar no centro do bloco de destino. O servidor precisa permitir `/tp`; esse recurso funciona também com `allowCommands: false`, que controla apenas `/give`. A construção só continua após confirmar a chegada; se o teleporte não for confirmado em 5 segundos, a tarefa informa a falha. `stop` e desconexões cancelam a espera.

Se a conexão cair durante `railway`, o bot guarda em memória o progresso, o destino original e a rota pendente e retoma a obra ao reconectar, incluindo as ações seguintes do mesmo pedido. Se uma operação da obra falhar antes da desconexão (por exemplo, `RAILWAY_PLACEMENT`), o checkpoint também é preservado: a obra fica interrompida e retoma do bloco pendente na próxima reconexão, sem repetir automaticamente enquanto estiver conectado. `stop` ou um novo pedido descarta essa retomada. Quando o servidor expulsa o bot (`kicked`), o progresso é salvo imediatamente, antes de encerrar a conexão, para que falhas de operações pendentes não descartem a obra. Isso vale enquanto o programa continuar aberto; reiniciar o programa descarta esse progresso. `stop` ou um novo pedido cancela a tarefa. Ao ocorrer `RAILWAY_TERRAIN_CHANGED`, o bot espera 10 segundos e tenta o mesmo bloco novamente. Se o erro se repetir e já houver um trilho nesse bloco, ele preserva o trilho e segue para o próximo; sem trilho, informa a falha.

Erros finais do `railway` e desconexões durante uma obra ativa ou aguardando retomada geram um arquivo JSON por ocorrência em `~/.minimini-bot/logs/railway/`. Com `MINIMINI_CONFIG`, a pasta fica em `logs/railway` ao lado do arquivo de configuração. O terminal informa o caminho salvo. O arquivo contém data, bot, dimensão, detalhes do erro (código, mensagem e stack) ou motivo enviado pelo servidor, posição do bot, bloco pendente, último bloco concluído, checkpoint e histórico dos trechos planejados, incluindo suas rotas e o destino original.

Cada diagnóstico consulta uma região de **100 blocos em X × 100 em Z × 10 em Y** (100 mil posições), centrada no bloco pendente ou no progresso da obra. Os deslocamentos são de -50 a +49 em X/Z e -5 a +4 em Y. Cada entrada contém posição e nome do bloco, incluindo ar; `name: null` indica uma posição indisponível/não carregada. O log inclui limites da região, contagens de posições indisponíveis e erros de leitura, além dos horários de início e fim da coleta. A coleta cede tempo aos eventos do servidor e não força o carregamento de chunks; por isso, os blocos podem mudar durante a varredura. Os arquivos permanecem após reiniciar o programa, não são apagados automaticamente e podem ocupar vários MB por ocorrência. Não incluem configurações, chaves ou sessões. O encerramento normal aguarda as gravações pendentes; encerramento forçado pode interrompê-las. Os instaladores dos três sistemas usam esse mesmo comportamento, sem configuração adicional.

Logs de debug e detalhes de busca não são enviados ao chat público; ficam no console do Node.js e nos diagnósticos persistentes. Respostas aos comandos e avisos de conclusão/falha continuam no chat. O terminal registra eventos JSON com o prefixo `[railway]`: início, planejamento, continuidade do desvio, ampliação da busca, ajuste de saída, aproximação, troca de piso, reposição de rampas, conexão de apoio, novas tentativas de colocação, reposição de materiais e cada bloco concluído. Conclusões, cancelamentos e falhas também são registrados; as falhas incluem coordenadas e os blocos ao redor para diagnóstico.

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
@bot1 faça uma picareta de pedra
@bot1 mode(default)
```

Comandos diretos continuam disponíveis no modo IA, especialmente `stop`. Pedidos em linguagem natural enviam à API a mensagem, as 20 interações anteriores com o bot, o catálogo de ações e um resumo limitado do estado do bot: posição, dimensão, tarefa, vida, fome, saturação, oxigênio, item equipado, inventário, jogadores conectados, entidades próximas e até 120 blocos da superfície visível nos chunks carregados, amostrados em um raio máximo de 12 chunks. O histórico fica somente na memória e é separado para cada bot. O modelo devolve uma resposta e até 8 ações. O plano inteiro é validado antes de executar: movimento, seguir, proteger, parar, consultar estado, equipar, olhar, minerar, colocar blocos, fabricar itens permitidos, construir ferrovias e esperar. A ação de ferrovia mantém `allowCommands: false`, salvo quando o pedido atual autoriza claramente a reposição por comando. O programa não executa código JavaScript produzido pela IA.

Para `faça uma picareta de pedra`, a IA pede o objetivo `craft(stone_pickaxe, 1)` em seu plano. O executor resolve as dependências pelas receitas do servidor: coleta madeira, faz tábuas e gravetos, prepara a bancada, fabrica uma picareta de madeira, minera pedra e fabrica a picareta de pedra. Aproveita materiais, ferramentas e bancada que já existam, pulando etapas desnecessárias. Essa notação descreve a ação interna; o pedido pelo chat é em linguagem natural no modo IA.

A fabricação aceita bancada, gravetos, tábuas, fornalha e ferramentas de madeira ou pedra. A quantidade de 1 a 16 é o **total desejado no inventário**, podendo sobrar itens quando a receita produz um lote. A coleta usa troncos e pedra expostos nos chunks carregados a até 32 blocos; o bot informa a falha se não encontrar recursos ou caminho. Cada objetivo tem limites de 128 operações, 10 níveis de dependência e 10 minutos. `stop` interrompe a tarefa, e o chat informa seu progresso. Veja os identificadores e os detalhes em [ações de IA](docs/ai.md).

As APIs exigem chaves próprias e podem cobrar por uso. Modelos e disponibilidade dependem da conta. Cada consulta tem limite de 30 segundos e pode ser cancelada por outro comando. Os resultados das ações são informados no chat. A fabricação resolve dependências localmente durante a execução, sem novas chamadas à IA; o restante do plano não é replanejado automaticamente. Não há memória persistente de conversa.

Consulte [configuração detalhada](docs/configuration.md) e [integrações de IA, ações e fontes oficiais](docs/ai.md).

## Sobrevivência e conexão

No Minecraft vanilla 26.1–26.1.2, o programa aplica uma correção de protocolo para itens de colmeia com abelhas. Ela lê o identificador da entidade antes do NBT, evitando o erro `array size is abnormally large, not reading: 167832854` ao receber o item e ao reconectar. A correção preserva os dados dos itens e os limites de segurança do NBT; não altera protocolos anteriores nem arquivos de `node_modules`. Após atualizar, reinicie o bot. Não é necessário apagar o inventário ou o mundo. A correção está no código comum aos instaladores Windows, Linux e macOS, sem dependências adicionais.

Todos os bots, em qualquer modo, comem automaticamente quando a fome chega ao limite configurado, se houver alimento seguro no inventário. A alimentação pausa o movimento e retoma a tarefa; se receber `stop` durante a refeição, permanece parado depois. Sem comida segura, o bot alerta somente quando a fome ou a vida chega a `8/20` ou menos, repetindo no máximo uma vez por minuto enquanto o risco continuar. Entregue alimentos e armas pelo inventário normal do Minecraft.

O bot evita alimentos prejudiciais/teletransporte. A navegação pode escavar blocos e construir apoios com terra (`dirt`) e pedregulho (`cobblestone`) ou pedra (`stone`) disponíveis no inventário. Isso não garante sobrevivência a todos os perigos. A coleta de recursos ocorre somente para atender a um objetivo de fabricação solicitado, dentro dos limites descritos acima; o bot não explora novos chunks para buscar materiais. Ao morrer, cancela a tarefa e aguarda o respawn do servidor. Falhas de conexão iniciam novas tentativas com intervalo crescente; remover um bot ou encerrar o programa cancela essas tentativas.

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

Arquitetura: `src/config.js` prepara e persiste configurações; `src/manager.js` gerencia conexões e chat; `src/controller.js` executa ações e sobrevivência; `src/crafting.js` resolve objetivos de fabricação; `src/ai/planner.js` integra as APIs. Scripts de instalação e inicialização ficam na raiz. Dados pessoais e sessões ficam fora do Git.

As alterações do projeto são mantidas na branch **`main`**, com commits e push após as verificações de cada mudança concluída. A atualização de uma instalação existente é descrita no [guia de instalação](docs/installation.md).
