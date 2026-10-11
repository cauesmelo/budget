# Budget

Budget é um aplicativo de finanças pessoais em português, com importação de extratos Itaú e planejamento de reservas. Roda no navegador, salva os dados localmente e oferece sincronização opcional pelo Google Drive, dentro das quotas gratuitas para uso pessoal.

## Rodar em qualquer computador

Instale [Node.js 22.12 ou mais recente](https://nodejs.org/), clone este projeto e execute:

```sh
npm ci
npm start
```

O navegador abre em **http://localhost:5173**. Mantenha o terminal aberto enquanto usar o aplicativo. Os lançadores `Iniciar.command` no macOS e `Iniciar.bat` no Windows fazem esses passos. No Linux, use `./iniciar.sh`. Ao atualizar o código com `git pull`, execute `npm ci` novamente.

Para desenvolvimento, `npm run dev`. Para uma versão estática: `npm run build`; para testar essa versão: `npm run preview`. A versão compilada tem manifesto e cache do aplicativo para acesso offline depois do primeiro carregamento, inclusive dos módulos de importação. A sincronização exige internet. A disponibilidade de instalação como aplicativo depende do navegador.

## Primeira utilização

1. Em **Importar arquivos**, selecione seu Budget. A prévia mostra o histórico e os itens de médio prazo. Confirme a importação.
2. Escolha a **competência da fatura** e importe os extratos da conta e do cartão Itaú, em `.xls` ou `.xlsx`. Confira os avisos e confirme.
3. Em **Lançamentos**, complete categoria e descrição. Data, lançamento original, valor, parcelas e origem já vêm preenchidos. Corrija o tipo quando necessário.
4. Em **Médio prazo**, confira a reserva inicial na abertura do primeiro mês, receitas, despesas e horizonte. Edite os valores esperados por mês e acompanhe os gráficos.
5. Em **Dados e nuvem**, exporte um backup ou configure a conexão com o Google Drive.

Arquivos repetidos mantêm suas edições e não recriam lançamentos excluídos. Movimentos idênticos que aparecem mais de uma vez no mesmo arquivo são preservados como ocorrências distintas. O reconhecimento depende de data, texto original, valor, conta, competência e parcela. Mudanças nessas informações em um novo extrato podem precisar de revisão.

## Como os valores são tratados

- Lançamentos usam centavos inteiros e sinal monetário: débito negativo, crédito positivo. Estornos do cartão reduzem o consumo.
- Pagamentos identificáveis da fatura, aplicações e resgates de principal são transferências. Não entram em consumo nem em receitas. Rendimentos identificados entram em receitas. Essa classificação pode ser corrigida na prévia ou na lista.
- O mês de uma compra no cartão é a competência da fatura. A data original da compra é preservada. Parcelas futuras **não são criadas automaticamente**: importe as faturas seguintes ou inclua o compromisso no planejamento.
- **Extratos e lançamentos** e **Histórico do Budget** têm visões separadas, pois a planilha já contém despesas que podem reaparecer nos extratos. As duas fontes nunca são somadas no mesmo total.
- O histórico do Budget conserva todas as categorias, inclusive categorias de trabalho. Os totais de consumo são reconstruídos pelas linhas e podem diferir dos indicadores “Total sem categorias de trabalho” da planilha. Investimentos identificados ficam como transferências.
- O planejamento é independente do realizado. Importar um extrato não altera automaticamente sua previsão.
- Reserva ao final = reserva na abertura + receitas planejadas − despesas de consumo + rendimento esperado sobre a abertura. O saldo final vira a abertura do mês seguinte. Aportes são metas internas, pois mover dinheiro para uma reserva não reduz o patrimônio total. Não são subtraídos nem adicionados novamente.
- A migração usa valores disponíveis nas células da planilha e cria campos editáveis; não executa fórmulas do Excel. Importações posteriores do Budget acrescentam registros novos e preservam os itens já editados no aplicativo.
- Uma fatura aberta pode mudar, e lançamentos bancários podem usar datas futuras de processamento. Os avisos da importação ajudam a revisar esses casos.

## Nuvem sem servidor pago

A opção implementada é **Google Drive**, usando a pasta própria do aplicativo e arquivos JSON. O Google Docs é um editor de texto; Google Sheets é uma alternativa se editar os dados diretamente como planilha for essencial. Drive oferece menos configuração e mantém o modelo completo do aplicativo. OneDrive é uma alternativa compatível com a conta Microsoft existente; Supabase é mais adequado quando houver vários usuários, mas o plano gratuito pode pausar por inatividade.

A configuração do Drive precisa de um ID OAuth criado na sua conta Google. Não requer senha bancária, Client Secret ou servidor. A autorização pede apenas `drive.appdata`. O token fica na memória e pode exigir uma nova conexão quando expirar. Siga o [guia de configuração e comparação](docs/NUVEM.md), com fontes oficiais e limites pesquisados em outubro de 2026.

Em outro computador, use o mesmo ID OAuth e **sincronize antes de começar**. A sincronização é acionada pelo botão e deve ser repetida depois das alterações. Ela reúne as últimas cópias dos computadores e salva uma nova cópia no Drive; mantém as anteriores. Se o mesmo registro for editado em dois computadores, a edição com horário mais recente prevalece. Mantenha os relógios dos computadores corretos. Exclusões também são sincronizadas. Edições simultâneas em campos do mesmo registro não são combinadas individualmente.

## Dados pessoais e GitHub

O código não inclui os arquivos fornecidos, lançamentos reais ou backups. O `.gitignore` exclui planilhas, extratos e as pastas `data`, `private` e `backups`. O backup JSON contém seus dados financeiros; salve-o fora do repositório. Credenciais OAuth e tokens não são incluídos no backup nem nos arquivos enviados ao Drive.

Os dados locais pertencem ao perfil do navegador e à origem/porta do site. Outro navegador ou uma porta diferente terá outro armazenamento. Limpar os dados do navegador ou usar uma janela anônima pode apagar a cópia local. Antes disso, exporte um backup ou sincronize.

A atualização do nome migra automaticamente os dados locais da versão anterior e continua reconhecendo seus backups e as cópias anteriores no Drive. O ID do dispositivo também é preservado. As novas cópias exportadas usam o nome `budget-backup-AAAA-MM-DD.json`.

Você pode salvar o código no seu GitHub pessoal e cloná-lo em outros computadores. Nenhum repositório remoto é criado nem enviado automaticamente. Para usar uma hospedagem estática, publique somente o conteúdo de `dist`, sem extratos e sem dados pessoais; cadastre a origem HTTPS correspondente no cliente OAuth. O projeto não precisa de hospedagem para funcionar localmente.

## Verificação

```sh
npm test
npm run build
```

Os testes cobrem cálculo em centavos, estornos, aportes, projeção, duplicidade, migração, exclusões, validação de backup e sincronização com chamadas Google simuladas.

Há testes opcionais para os três arquivos de referência. Eles leem os arquivos diretamente e não os copiam para o projeto:

```sh
PRIVATE_IMPORT_DIR="$HOME/Downloads" npm run test:files
```

Os nomes de referência estão em `tests/private-files.test.ts`; fora desse ambiente, os testes privados são ignorados. A autorização real do Google só pode ser validada depois de configurar seu próprio ID OAuth.

## Estrutura

`src/App.tsx` contém as telas. `src/lib/importers.ts` lê os formatos. `src/lib/finance.ts` calcula totais, projeções e fusões. `src/lib/storage.ts` valida e guarda os dados no IndexedDB. `src/lib/drive.ts` autoriza o Google e sincroniza cópias. O código usa React, TypeScript, Vite, Recharts e a versão oficial do SheetJS CE.
