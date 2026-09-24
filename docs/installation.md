# Instalação e execução

Baixe o [ZIP da branch main](https://github.com/soaresbest/minimini-bot/archive/refs/heads/main.zip) e extraia todo o conteúdo para uma pasta onde seu usuário possa escrever. É possível usar Git, mas ele não é uma dependência da instalação. Não execute os arquivos diretamente de dentro do ZIP.

Os instaladores informam e pedem confirmação antes de cada etapa: verificar o sistema, preparar Node.js 24, instalar dependências e iniciar o bot. Na primeira inicialização, o programa solicita as configurações no terminal. Mantenha essa janela aberta enquanto os bots estiverem conectados; `Ctrl+C` encerra o programa.

As três primeiras etapas preparam o ambiente. Se o aplicativo não puder iniciar por configuração, autenticação ou incompatibilidade da versão do servidor, o instalador informa que o ambiente foi concluído e preservado; depois da correção, use apenas o iniciador do sistema.

## Windows

Abra `install.cmd` com dois cliques. Ele chama o Windows PowerShell 5.1, que acompanha Windows 10/11, com uma política válida somente para esse processo. A política permanente da máquina não é alterada. Se uma política corporativa bloquear scripts, solicite a liberação ao administrador.

Também é possível executar pelo PowerShell, dentro da pasta extraída:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Para executar novamente, abra `start.cmd`. Para reabrir a configuração:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 --configure
```

Não são necessários Node.js, npm, Git, Python, Visual Studio ou acesso de administrador previamente instalados. O instalador usa as ferramentas incluídas no Windows para baixar e extrair o Node.js oficial.

## Linux e macOS

No terminal, entre na pasta extraída e execute:

```bash
bash install.sh
```

No macOS também há `install.command` e `start.command`, que abrem no Terminal. Se o Finder não autorizar sua execução após a extração, use o comando Bash acima. Para executar novamente e para reabrir a configuração:

```bash
bash start.sh
bash start.sh --configure
```

Bash e ferramentas básicas do próprio sistema são necessários para abrir o instalador. No macOS, download, extração e checksum usam as ferramentas já incluídas no sistema. Em Linux mínimo, o instalador oferece instalar `ca-certificates`, `curl`, `tar`, `gzip`, `coreutils`, `awk` e `libstdc++` usando `apt-get`, `dnf`, `yum`, `zypper` ou `pacman`. Somente essa instalação de pacotes do sistema pode pedir `sudo`; execute o instalador como seu usuário habitual. Se não houver `sudo` ou gerenciador reconhecido, ele informa os pacotes que o administrador precisa preparar.

## Versão do Node e arquivos criados

Um Node.js 24 compatível que já tenha npm é reutilizado. Caso não exista, o instalador baixa a versão mais recente da série 24 disponível em `nodejs.org`, confere o arquivo com o SHA-256 publicado no mesmo site por HTTPS e o instala em:

- Linux/macOS: `~/.minimini-bot/runtime/node`.
- Windows: `%USERPROFILE%\.minimini-bot\runtime\node`.

Essa conferência detecta arquivos incompletos/corrompidos; o instalador não faz validação adicional das assinaturas GPG do manifesto. Os iniciadores dão preferência ao runtime local e ajustam o `PATH` apenas para o processo. O Node.js de outros projetos e a configuração permanente do shell permanecem disponíveis.

As dependências do aplicativo ficam em `node_modules` na pasta extraída. O comando `npm ci` recria essa pasta seguindo exatamente `package-lock.json`. O programa grava configurações e credenciais em `~/.minimini-bot`, fora do repositório; a configuração padrão fica em `~/.minimini-bot/config.json`. Não compartilhe essa pasta pessoal.

Executar novamente o instalador é seguro: ele reutiliza Node.js 24 e refaz a instalação das dependências. Se precisar substituir um runtime local inválido, preserva o diretório anterior com um sufixo `.backup-*`.

## Sistemas atendidos

| Sistema | Arquiteturas atendidas pelo instalador | Requisitos |
| --- | --- | --- |
| Windows | x64, arm64 | Windows 10/Server 2016 ou mais recente; Windows PowerShell 5.1+ |
| macOS | Intel x64, Apple Silicon arm64 | macOS 13.5 ou mais recente |
| Linux com glibc | x64, arm64 | glibc 2.28+, kernel 4.18+, libstdc++ 6.0.25+ |

Use uma versão do sistema operacional que ainda receba suporte do fabricante. Alpine/musl, sistemas de 32 bits e outras arquiteturas não são atendidos por estes instaladores. Eles não tentam adaptar um binário incompatível. WSL deve ser tratado como um ambiente Linux; o Node.js não oferece suporte oficial a problemas exclusivos do WSL. Esses limites vêm dos [requisitos oficiais do Node.js 24](https://github.com/nodejs/node/blob/v24.x/BUILDING.md#supported-platforms).

A instalação precisa de acesso HTTPS a `nodejs.org` e ao registro npm. A execução precisa de acesso ao servidor Minecraft e, se habilitada, à API do provedor de IA. O projeto usa Minecraft Java Edition; ele não inclui um servidor Minecraft nem configura contas Microsoft automaticamente.

## Instalação sem perguntas e atualização

Para preparar dependências em automação, sem iniciar o bot nem solicitar sua configuração:

```bash
bash install.sh --yes --no-start
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Yes -NoStart
```

`--yes`/`-Yes` confirma as etapas do instalador; a configuração inicial do bot continua interativa se a inicialização for solicitada. Em execução automática, use os dois parâmetros acima. Para ajuda, use `bash install.sh --help` ou `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Help`.

Para atualizar o aplicativo, encerre o bot, extraia um novo ZIP em uma pasta nova e execute o instalador nela. As configurações da sua home serão reutilizadas. Se utiliza Git, atualize a branch `main` e execute o instalador novamente. Reexecutar o instalador em uma cópia antiga não baixa uma nova versão do código-fonte.

## Diagnóstico

- Se o download ou a validação SHA-256 falhar, a instalação é interrompida; verifique a conexão e execute novamente.
- Se `npm ci` falhar, confirme que o ZIP foi extraído por completo e contém `package-lock.json`, e que o registro npm está acessível. Não remova o arquivo de lock para contornar o erro.
- Se o Node.js não conseguir executar em Linux, o instalador oferece preparar bibliotecas do sistema. Se ainda falhar, confira os requisitos de glibc/kernel/libstdc++ da tabela.
- Os iniciadores informam quando Node.js 24 ou dependências estiverem ausentes e orientam executar o instalador novamente.
- Mensagens de autenticação ou conexão com Minecraft são produzidas pelo aplicativo depois da instalação; confira servidor, porta, versão e conta na configuração.
