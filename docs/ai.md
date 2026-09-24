# Integração com IA

Cada bot pode usar `mode(ia)` e voltar aos comandos diretos com `mode(default)`. A configuração guarda o provedor geral em `llm.provider` e permite sobrescrever `provider` e `model` de cada bot. A chave do provedor precisa estar configurada antes de ativar o modo IA. Nunca envie chaves pelo chat do Minecraft.

| Provedor | Identificador | Modelo inicial | Variável de ambiente |
| --- | --- | --- | --- |
| OpenAI / ChatGPT | `openai` | `gpt-4.1-mini` | `OPENAI_API_KEY` |
| Google Gemini | `gemini` | `gemini-2.5-flash` | `GEMINI_API_KEY` |
| xAI Grok | `grok` | `grok-4.7` | `XAI_API_KEY` |
| Anthropic Claude | `claude` | `claude-haiku-4-5` | `ANTHROPIC_API_KEY` |

Os modelos são configuráveis; disponibilidade, cotas e cobrança dependem da conta de cada provedor. A assinatura de um aplicativo de conversa não é uma chave de API. Os modelos acima são escolhas iniciais para este projeto, não uma comparação de qualidade ou preço.

Fragmento do arquivo de configuração pessoal (mantenha também os outros campos criados pelo assistente de instalação):

```json
{
  "llm": {
    "provider": "openai",
    "providers": {
      "openai": { "model": "gpt-4.1-mini" },
      "gemini": { "model": "gemini-2.5-flash" },
      "grok": { "model": "grok-4.7" },
      "claude": { "model": "claude-haiku-4-5" }
    }
  }
}
```

A variável de ambiente tem prioridade sobre o campo opcional `apiKey` dentro das configurações do provedor. Provedor/modelo do bot têm prioridade sobre o provedor geral/modelo do provedor. O arquivo pessoal e as sessões de autenticação ficam fora do repositório.

## Como um pedido vira uma ação

Uma mensagem dirigida ao bot gera uma única consulta à API. Ela envia a mensagem atual, as 20 interações anteriores com aquele bot em ordem cronológica, um catálogo das ações implementadas e um resumo limitado do mundo: posição, dimensão, tarefa, vida, fome, saturação, oxigênio, item equipado, até 50 itens do inventário, jogadores conectados e entidades próximas. A conversa fica somente na memória do processo, separada por bot, e é apagada ao reiniciar.

Também são enviados até 120 blocos da superfície visível nos chunks carregados, com nome, posição e distância. A amostragem lança raios ao redor do bot até o máximo de 12 chunks (192 blocos); chunks ausentes não são carregados apenas para montar o contexto. Essa lista representa superfícies vistas a partir do bot, não um mapa completo da área. A configuração inteira, endereço do servidor, sessões e chaves não são enviados como contexto. Chaves conhecidas são removidas dos textos. Esse resumo, o histórico e a mensagem atual são processados pelo provedor escolhido.

A API devolve uma resposta curta e até oito ações ordenadas. O programa valida **todo** o plano antes de executar qualquer ação. Campos desconhecidos, coordenadas inválidas, nomes malformados, respostas incompletas e operações fora da lista são rejeitados. Não há `eval`, execução de shell, JavaScript gerado ou acesso irrestrito às APIs do Mineflayer.

| Ação | Parâmetros | Execução |
| --- | --- | --- |
| `goto` | `x`, `y`, `z` | Caminha até a posição. |
| `follow` | `player` | Segue jogador conectado; deve ser a última ação. |
| `guard` | `player` | Segue e protege de mobs hostis e de agressores identificados pelo servidor; deve ser a última ação. |
| `stop` | Nenhum | Cancela a tarefa. |
| `status` | Nenhum | Informa vida, fome, tarefa e itens. |
| `help` | Nenhum | Informa comandos. |
| `equip` | `item` | Equipa item do inventário na mão. |
| `craft` | `item` da lista permitida, `count` inteiro de 1 a 16 | Garante a quantidade total no inventário, coletando materiais e fabricando dependências necessárias. |
| `look` | `x`, `y`, `z` | Olha para a posição. |
| `dig` | `x`, `y`, `z` inteiros | Quebra bloco carregado ao alcance. |
| `place` | `x`, `y`, `z` inteiros, `face`, `item` | Coloca item na face de um bloco de referência. |
| `wait` | `seconds` de 0 a 30 | Aguarda com possibilidade de cancelamento. |

Em `place`, `x,y,z` identificam o **bloco de referência**, e `face` aceita `up`, `down`, `north`, `south`, `east` ou `west`. A posição colocada é a referência acrescida do vetor dessa face. O executor ainda verifica alcance, disponibilidade do item e do bloco. Coordenadas horizontais são limitadas a ±29.999.984 e verticais a -2048…2047; limites reais da dimensão e blocos carregados continuam valendo no servidor.

Exemplo de plano aceito:

```json
{
  "reply": "Vou até a posição e verifico meu estado.",
  "actions": [
    { "type": "goto", "x": 100, "y": 60, "z": 300 },
    { "type": "status" }
  ]
}
```

## Objetivos de fabricação

No modo IA, o pedido `@bot1 faça uma picareta de pedra` pode gerar este plano:

```json
{
  "reply": "Vou reunir os materiais e fabricar uma picareta de pedra.",
  "actions": [
    { "type": "craft", "item": "stone_pickaxe", "count": 1 }
  ]
}
```

A IA define o objetivo final. O executor consulta as receitas da versão do servidor com `recipesAll`, resolve as dependências recursivamente e usa `craft` para fabricar. Com inventário vazio e recursos acessíveis, a sequência é:

1. Procurar e coletar madeira, convertendo-a em tábuas e gravetos conforme necessário.
2. Fabricar e colocar uma bancada.
3. Fabricar uma picareta de madeira.
4. Usar a picareta para minerar pedra e recolher pedregulho (`cobblestone`).
5. Fabricar a picareta de pedra.

O inventário é consultado durante a execução. Materiais, ferramentas e uma bancada próxima são reaproveitados, então etapas já atendidas são puladas. `count` significa o **total desejado no inventário**, não unidades adicionais: se já houver uma picareta de pedra, `count: 1` não fabrica outra. Receitas que produzem vários itens por vez podem ultrapassar esse total, como um lote de quatro gravetos. O bot relata o progresso no chat, e `stop` cancela tanto a coleta quanto a fabricação.

`item` aceita somente os identificadores abaixo, também com o prefixo opcional `minecraft:`. O item e sua receita precisam existir na versão conectada:

| Grupo | Identificadores |
| --- | --- |
| Utilitários | `crafting_table`, `stick`, `furnace` |
| Ferramentas de madeira | `wooden_pickaxe`, `wooden_axe`, `wooden_shovel`, `wooden_hoe`, `wooden_sword` |
| Ferramentas de pedra | `stone_pickaxe`, `stone_axe`, `stone_shovel`, `stone_hoe`, `stone_sword` |
| Tábuas | `oak_planks`, `spruce_planks`, `birch_planks`, `jungle_planks`, `acacia_planks`, `dark_oak_planks`, `mangrove_planks`, `cherry_planks`, `pale_oak_planks`, `crimson_planks`, `warped_planks` |

O objetivo autoriza a coleta e a colocação da bancada necessárias para fabricar o item. A busca procura troncos e pedra expostos em chunks carregados a até **32 blocos**; não explora novos chunks nem escava túneis para localizar recursos. A amostra `nearbyBlocks` enviada à IA não precisa mostrar todos os materiais: o executor faz a busca local quando chegar a essa etapa. Se faltar um recurso, uma receita ou um caminho, a tarefa para com uma explicação.

Mantenha pelo menos um espaço livre no inventário. A tarefa não descarta itens para abrir espaço e só confirma coleta ou fabricação quando o resultado aparece no inventário. `stop` impede as próximas etapas; uma receita já enviada ao servidor pode terminar, mantendo a mão ocupada até a operação encerrar.

Cada objetivo fica limitado a **128 operações, 10 níveis de dependência e 10 minutos**. Cada operação também respeita `settings.actionTimeoutMs` (120 segundos por padrão). Esses limites são independentes dos 30 segundos da consulta à IA e das oito ações do plano: as etapas internas de `craft` não exigem novas ações da IA.

## Limites e falhas

Cada pedido tem prazo de 30 segundos, limite de 2.000 caracteres de entrada, resposta HTTP de até 128 KiB e até 2.048 tokens de saída. Não há repetição automática de chamadas cobradas. `stop`, troca de tarefa ou desconexão podem cancelar a consulta pela sinalização do gerenciador. Respostas recusadas, truncadas ou inválidas nunca viram ações parciais. Em `craft`, as dependências são resolvidas localmente conforme o inventário e o mundo, sem outra consulta à IA. Os resultados das ações não são enviados à IA para replanejar o restante do plano automaticamente; uma nova mensagem pode solicitar a próxima tarefa.

Erros mostram instruções curtas em português. Corpos HTTP, cabeçalhos e mensagens brutas de rede não são exibidos, porque podem conter credenciais. Os testes usam respostas HTTP simuladas dos quatro provedores e não consomem créditos de API.

## APIs e fontes oficiais

Consultadas durante a implementação em setembro de 2026:

- OpenAI: [Responses com Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), com `text.format` JSON Schema estrito e `store: false`; [modelo GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini).
- Google: [Generate Content e saídas estruturadas](https://ai.google.dev/gemini-api/docs/generate-content/structured-output), usando `generationConfig.responseFormat.text` com MIME JSON e esquema; [referência de GenerationConfig](https://ai.google.dev/api/generate-content#v1beta.GenerationConfig).
- Anthropic: [definição e seleção de ferramentas](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools), usando Messages e a ferramenta única `minecraft_plan`; [modelos](https://platform.claude.com/docs/en/models/overview). O modelo escolhido precisa suportar `tool_choice` forçado; alguns modelos mais recentes não suportam essa opção.
- xAI: [Structured Outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs), com Chat Completions e `response_format.json_schema`; [aposentadoria dos modelos anteriores](https://docs.x.ai/developers/migration/may-15-retirement).

Para acrescentar uma ação, atualize o esquema, a validação, o catálogo enviado à IA, o executor e os testes. Uma nova ação nunca deve permitir executar código arbitrário retornado pelo modelo.
