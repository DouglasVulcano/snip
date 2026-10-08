<div align="center">

# 🌳 Bonsai

**Pode o contexto do Claude Code. Não o resuma.**

Um plugin do Claude Code que troca o resumo escrito por modelo do `/compact` por uma
poda determinística: o que sobra de saída de ferramenta, velha ou gigante, vai
embora; sua conversa, decisões e planos ficam palavra por palavra. Instantâneo,
grátis e sem chamada extra ao modelo.

[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-2a78d6.svg)](LICENSE)
[![Plugin do Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-eb6834.svg)](https://docs.claude.com/en/docs/claude-code)
[![Testado na 2.1.293](https://img.shields.io/badge/testado%20na-Claude%20Code%202.1.293-1baf7a.svg)](#requisitos)
[![English](https://img.shields.io/badge/lang-en-8a897f.svg)](README.md)

</div>

---

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/recall-dark.svg">
  <img alt="O Bonsai mantém fatos recentes e das bordas com exatidão; o resumo nativo guarda menos da metade dos detalhes" src="docs/img/recall-light.svg">
</picture>

<sub>Fatos lembrados com exatidão depois da compactação, 64 execuções reais contra o
Claude Code (8 tentativas × 4 braços × sessão viva/retomada). Método completo e todas
as ressalvas em [docs/benchmark.md](docs/benchmark.md) (em inglês).</sub>

## Por quê

O `/compact` pede a um modelo que **reescreva** sua sessão como um resumo. Isso leva
segundos, gasta tokens e perde informação de formas imprevisíveis. Mas veja o que
realmente enche uma sessão longa: em transcritos reais, **87% do texto são chamadas
de ferramenta e a saída delas**, e só 13% são você e o assistente conversando.

O Bonsai remove a saída de ferramenta que você não precisa mais e deixa todo o resto
como está.

```
antes                                   depois
──────────────────────────────          ──────────────────────────────
você: "use a porta 8472"       mantém   você: "use a porta 8472"
assistente: plano: …           mantém   assistente: plano: …
resultado: 18.000 caracteres   corta    resultado: primeiros 600 + últimos 300
resultado: mesmo Read, de novo remove   [Bonsai pruned this result: Read a.ts …]
resultado: o último, recente   mantém   resultado: o último, recente
```

## Instalação

```bash
claude plugin marketplace add DouglasVulcano/claude-bonsai
claude plugin install bonsai@claude-bonsai
```

Só isso: o próximo `/compact` passa a ser uma poda. Sem chave de API, sem rede, sem
chamadas extras ao modelo. O instalador avisa que algumas opções estão "not yet set";
isso só significa que você não as personalizou, os padrões valem. Dentro de uma
sessão do Claude Code os mesmos dois passos são `/plugin marketplace add …` e
`/plugin install …`.

<details>
<summary>Ou rode direto do código-fonte</summary>

```bash
git clone https://github.com/DouglasVulcano/claude-bonsai
claude --plugin-dir ./claude-bonsai
```
</details>

## O que você ganha

|  | `/compact` nativo | **Bonsai** |
|---|---|---|
| Tempo para compactar | 14,2 s | **0,16 s** |
| Custo da compactação | US$ 0,071 | **US$ 0** |
| Tamanho da conversa depois (de ~98 mil tokens) | 19 mil (−81%) | 40 mil (−59%) |
| Fatos específicos lembrados, mesma sessão | 48% | **75%** |
| Fatos de arquivos lidos recentemente | 31% | **100%** |
| Suas mensagens e decisões | 100% | 100% |
| Regras do `CLAUDE.md` ainda seguidas | 100% | 100% |
| Fatos do *meio* de resultados antigos e longos | 13% | 0% |
| Determinístico | não | **sim** |

O Bonsai compacta menos do que um resumo consegue e não guarda o meio de um resultado
antigo de ferramenta. É a escolha certa quando você prefere manter o texto exato e
reler um arquivo a confiar numa paráfrase.
[Os números e de onde vêm](docs/benchmark.md).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/cost-dark.svg">
  <img alt="Tempo e custo de modelo da compactação" src="docs/img/cost-light.svg">
</picture>

## Como funciona

O Bonsai se pendura no `session.compact`, por onde passa toda compactação (o seu
`/compact`, a automática do Claude Code e a de um plugin), e percorre a conversa uma
vez:

1. **Protegido:** suas mensagens, o texto do assistente, as 8 últimas mensagens e os
   resultados de `Agent`, `Task`, `AskUserQuestion` e `ExitPlanMode` nunca são
   tocados.
2. **Substituído:** um resultado vira um marcador de uma linha se o mesmo `Read`,
   `Bash`, `Grep`, `Glob` ou `WebFetch` rodou de novo depois.
3. **Grande demais:** um resultado antigo com mais de 2.000 caracteres mantém os
   primeiros 600 e os últimos 300 (erros e conclusões ficam no fim).
4. **Chamadas grandes:** o mesmo corte vale para campos longos de chamadas antigas,
   como o conteúdo de um `Write`.

Pares `tool_use` / `tool_result` nunca são separados. Se a poda economizar menos de
15%, o resumo do próprio Claude Code roda no lugar, então você nunca fica pior do que
sem o plugin. Detalhes em [docs/how-it-works.md](docs/how-it-works.md).

Em 9 sessões reais o Bonsai remove **49%** dos caracteres da conversa (mediana 40%);
metade disso vem das entradas das chamadas de ferramenta, não só dos resultados.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/replay-dark.svg">
  <img alt="O que enche uma sessão real e o que o Bonsai remove" src="docs/img/replay-light.svg">
</picture>

## Configuração

Tudo tem um padrão. As opções aparecem no `/config`, ou no `settings.json`:

```json
{ "pluginConfigs": { "bonsai": { "options": { "preserveRecent": 4, "keepMaxChars": 1000 } } } }
```

| Opção | Padrão | |
|---|---|---|
| `preserveRecent` | `8` | mensagens do fim que nunca são tocadas |
| `keepMaxChars` | `2000` | resultados antigos maiores que isso são cortados |
| `headChars` / `tailChars` | `600` / `300` | o que sobra de um corte |
| `minSavingsPercent` | `15` | abaixo disso, cai no resumo nativo |
| `pruneInputs` | `true` | também corta campos longos de chamadas antigas |
| `keepTools` | `Agent,Task,…` | ferramentas cuja saída nunca é podada |
| `triggerPercent` | `35` | poda sozinho acima desta fatia da janela (só interativo) |
| `relink` | `true` | mantém a poda após `--continue` / `--resume` |

Todas as opções, com dicas de ajuste: [docs/configuration.md](docs/configuration.md).
Baixe `preserveRecent` e `keepMaxChars` para o perfil *tight* dos gráficos: −72% da
conversa, ao preço de esquecer mais das leituras recentes.

## Limitações

Leia antes de depender dele.

- **O que foi cortado se perde.** Um fato no meio de um resultado antigo e longo não
  está mais no contexto. O Claude pode ler o arquivo de novo; não vai se lembrar dele.
- **Retomar a sessão é mais ruidoso.** A poda sobrevive ao `--continue` (cerca de 43
  mil tokens contra 106 mil), mas medi o motor às vezes trazendo de volta parte do
  conteúdo cortado e, em 1 de 16 execuções retomadas, perdendo um fato recente. Não
  consegui explicar tudo. [Detalhes](docs/benchmark.md#3-after---continue).
- **O gatilho proativo não foi testado.** Podar sozinho numa fatia da janela exige o
  `$.session.compact()`, que não existe em sessões headless; só consegui exercitar o
  `/compact`. Trate o `triggerPercent` como experimental.
- **Um modelo, um cenário sintético, amostras pequenas.** Haiku, 8 tentativas por
  célula. A página do benchmark lista como o desenho influenciou o resultado.
- **API em acesso antecipado.** Os hooks de função podem mudar entre versões do
  Claude Code.

## Requisitos

Claude Code com hooks de função. Testado na **2.1.293**, onde nenhuma flag é
necessária. Versões mais antigas, que trazem isso como acesso antecipado, podem pedir
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` no bloco `env` do `settings.json`.

## Meça você mesmo

```bash
node bench/replay.mjs                     # grátis: reprocessa seus transcritos, guarda só agregados
node bench/e2e.mjs --trials 8             # execuções reais contra o motor (usa seu plano)
python bench/report.py                    # gráficos + summary.json
```

## Contribuindo

Issues e pull requests são bem-vindos, em especial novas regras de poda amparadas por
um número do benchmark e um adaptador para outros agentes (o podador em
[`hooks/prune.ts`](hooks/prune.ts) não depende do Claude Code). Veja o
[CONTRIBUTING.md](CONTRIBUTING.md).

## Licença

[MIT](LICENSE) © Douglas Vulcano
