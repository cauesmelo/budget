# Dados na nuvem, sem servidor próprio

O Budget funciona no navegador e salva os dados localmente em IndexedDB. A sincronização opcional salva backups JSON na pasta privada do aplicativo no Google Drive. Assim, o mesmo projeto pode ser clonado em vários computadores, usando a mesma conta Google e a mesma configuração OAuth.

A integração já está implementada. Para habilitá-la, você precisa criar o Client ID na sua conta Google; o projeto não contém credenciais de terceiros. A existência da integração no código não significa que uma conta já tenha sido configurada ou que uma sincronização real tenha sido realizada.

## Opções comparadas

Informações verificadas em fontes oficiais em **11 de outubro de 2026**. A recomendação considera um aplicativo pessoal, usado por uma pessoa, que importa extratos mensalmente e precisa funcionar offline.

| Opção | Vantagens | Requisitos e limites | Escolha para este projeto |
| --- | --- | --- | --- |
| Google Drive: JSON na pasta do aplicativo | Guarda todo o estado estruturado; permissões limitadas; utiliza uma conta Google existente; dispensa servidor | Criar projeto e cliente OAuth; conectar no navegador; acompanhar espaço disponível na conta | **Implementada e recomendada** |
| Google Sheets | Dados legíveis e editáveis como planilha; API com operações em lote | Mesma configuração OAuth; manutenção da estrutura da planilha; tratar edição manual e alterações concorrentes | Boa alternativa se editar a base como planilha for prioridade |
| OneDrive: JSON na pasta do aplicativo | Aproveita a conta Microsoft/Office existente; permissões limitadas a uma pasta | Registrar aplicação no Microsoft Entra; implementar OAuth com PKCE e integração Microsoft Graph | Alternativa possível, ainda não implementada |
| Supabase Free | Banco PostgreSQL, autenticação, consultas e regras de acesso | Criar projeto, esquema e regras; plano gratuito pode pausar por pouca atividade | Melhor se o produto crescer para vários usuários; desnecessário nesta versão |
| Somente armazenamento local + backup JSON | Funciona sem configurar serviço externo | Você precisa transportar os backups entre computadores e conservá-los | Disponível desde o primeiro uso |

Google Docs é um documento de texto. Para usar uma planilha como base de dados, a opção seria **Google Sheets**. Para o modelo do Budget, um JSON no Drive preserva lançamentos, categorias, planejamento e configurações sem converter toda alteração em manipulação de células.

## Configurar o Google Drive

Você faz esta configuração uma vez na conta que será usada para guardar os dados. Não é necessário contratar hospedagem nem usar uma conta de serviço.

1. Acesse o [Google Cloud Console](https://console.cloud.google.com/) e crie um projeto, por exemplo, `Budget pessoal`.
2. Em **APIs e serviços → Biblioteca**, habilite a **Google Drive API**.
3. Abra **Google Auth Platform**. Configure o nome do aplicativo, email de suporte e email de contato. Para uma conta pessoal, escolha a audiência **External**.
4. Em **Data Access**, adicione somente o escopo `https://www.googleapis.com/auth/drive.appdata`. Esse escopo é classificado como **não sensível** e permite guardar dados na pasta própria do aplicativo; não concede acesso a todos os documentos do seu Drive. [Escopos do Drive](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).
5. Em **Clients**, crie um cliente OAuth de tipo **Web application**. Em **Authorized JavaScript origins**, cadastre estas duas origens:

   ```text
   http://localhost
   http://localhost:5173
   ```

   Use o endereço `http://localhost:5173` para abrir o aplicativo. A porta de desenvolvimento é fixa. As origens não levam caminhos, barra final nem o nome do repositório. Se alterar a porta no projeto, cadastre a nova origem. A configuração oficial pede tanto a origem localhost quanto a origem com a porta. Domínios externos exigem HTTPS; localhost tem uma exceção para desenvolvimento. [Configuração do cliente](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid), [regras de origem](https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow).
6. Copie o **Client ID**, terminado em `.apps.googleusercontent.com`, e informe-o nas configurações de nuvem do Budget. Não copie o Client Secret. O fluxo usado aqui é de navegador e não precisa desse segredo. [Client ID e operações de servidor](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid).
7. Se o aplicativo estiver em **Testing**, adicione o email da sua conta em **Test users**. Esse modo admite até 100 test users e o consentimento expira após sete dias, exigindo uma nova autorização. Para uso contínuo pessoal, você pode mudar a audiência para **In production**; a limitação semanal de Testing deixa de se aplicar. [Audiência e publicação](https://support.google.com/cloud/answer/15549945?hl=en).
8. No Budget, clique em **Conectar**, escolha sua conta e autorize a pasta do aplicativo. Depois clique em **Sincronizar**. Em outro computador, configure o mesmo Client ID, conecte a mesma conta e sincronize para recuperar os dados.

O Google prevê uma exceção à submissão para revisão quando o aplicativo é usado somente por você ou por poucas pessoas conhecidas. Uma distribuição pública pode precisar de verificação. Exibir nome/logo verificados no consentimento envolve a verificação da marca; não há garantia de ausência de avisos em toda configuração. O escopo não sensível utilizado evita pedir a revisão adicional de acesso a todo o Drive. [Verificação da marca e exceção para uso pessoal](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification).

Não troque de projeto OAuth para usar cada computador: reutilize o Client ID da mesma aplicação. Se usar outra conta Google, seus dados remotos estarão em outra conta. A pasta é própria da aplicação e não aparece como um arquivo comum no Drive. [Pasta de dados do aplicativo](https://developers.google.com/workspace/drive/api/guides/appdata).

## Como a sincronização funciona

Ao clicar em sincronizar, o Budget:

1. Identifica este navegador por um ID aleatório, persistido localmente. O ID não contém nome, email nem identificação bancária.
2. Lista os backups do aplicativo no Drive, incluindo todas as páginas da listagem.
3. Seleciona o backup mais recente de **cada navegador/dispositivo**, usando a data de modificação e, em empate, o ID do arquivo.
4. Baixa e valida esses backups antes de aceitar os dados. Se um último backup estiver inválido, o envio é interrompido e os dados locais são preservados.
5. Reúne os registros locais com os de todos esses backups. Registros diferentes são conservados; para alterações do mesmo registro, prevalece a versão mais recente. Exclusões usam registros de exclusão para não ressuscitar um lançamento apagado em outro computador. Empates são resolvidos deterministicamente pelo conteúdo.
6. Cria um **novo backup completo** na pasta do aplicativo. A integração não altera nem apaga os backups anteriores.

Isso evita sobrescrever um arquivo único que outro computador acabou de atualizar. Se dois computadores sincronizarem ao mesmo tempo, cada um cria seu próprio arquivo; a próxima sincronização reúne o último arquivo de cada um. Eles podem mostrar estados diferentes até essa próxima sincronização. Isso não é colaboração simultânea em tempo real.

Para um mesmo registro editado offline em dois computadores, uma das versões vence pela regra de atualização. As configurações financeiras também têm uma versão; edições simultâneas das configurações não são mescladas campo por campo. Para trabalho com vários dispositivos, sincronize antes de começar e novamente após terminar.

Na primeira sincronização de um navegador vazio com configurações financeiras padrão, o programa adota o planejamento/configuração existente na nuvem. O estado recém-criado não substitui o orçamento anterior apenas por ter uma data de criação mais recente.

Abas do mesmo navegador compartilham o ID local. Nos navegadores que suportam **Web Locks**, a sincronização é serializada entre abas. Em navegadores sem esse recurso, use uma única aba para sincronizar. O ID depende da origem do site e do perfil do navegador; trocar navegador/perfil ou limpar o armazenamento cria outro ID.

O Client ID é uma configuração local pública e **não entra no JSON sincronizado nem no backup exportado**. Ao recuperar dados da nuvem, o Client ID configurado naquele computador é preservado.

## Sessão e segurança

O aplicativo carrega a biblioteca oficial Google Identity Services e obtém um token temporário por uma janela de autorização. O token fica somente em memória, não é gravado em IndexedDB/localStorage, não é exportado e não é enviado ao GitHub. O programa não usa Client Secret nem solicita a senha bancária. As chamadas ao Drive usam HTTPS e o escopo `drive.appdata`.

O Google documenta o fluxo de token para aplicativos de navegador, com acesso direto a APIs por REST/CORS. Esse fluxo não utiliza refresh tokens de servidor. Quando a autorização temporária expira ou a página é recarregada, você pode precisar clicar em conectar novamente. A aplicação encerra a validade local um pouco antes da expiração informada pelo Google. [Google Identity Services: modelo de token](https://developers.google.com/identity/oauth2/web/guides/use-token-model).

**Desconectar** encerra a sessão local, cancela requests em andamento e tenta revogar a autorização no Google. Não apaga os dados locais nem os backups remotos. A revogação remota depende da conexão com o Google; você também pode revisar as permissões em [conexões da conta Google](https://myaccount.google.com/connections).

Os arquivos JSON contêm seus dados financeiros. Eles são privados na sua conta, mas esta versão **não faz criptografia por senha no próprio aplicativo**. Quem tiver acesso ao seu navegador/perfil pode ler os dados locais. Guarde backups exportados com o mesmo cuidado que os extratos. Não faça commit de extratos, backups ou dados reais em repositórios.

## Espaço e custo

O uso padrão da Google Drive API está disponível sem custo adicional. A documentação foi atualizada em maio de 2026: para novos projetos, informa limites por minuto, tráfego diário de 1 TB e limiar gratuito de 400 milhões de unidades de quota por dia. O Google anunciou cobrança futura para uso acima das quotas, com aviso prévio de pelo menos 90 dias. Uma aplicação pessoal com poucas sincronizações fica muito abaixo desses volumes; a gratuidade depende das quotas e das condições do serviço. [Limites e preço atuais do Drive](https://developers.google.com/workspace/drive/api/guides/limits).

Uma conta Google inclui atualmente **até 15 GB** compartilhados com Gmail, Google Drive e Google Photos. É preciso haver espaço disponível na conta. [Armazenamento incluído](https://support.google.com/googleone/answer/9004014?hl=en-419).

Um histórico pessoal estruturado costuma ocupar poucos MB, mas cada sincronização acrescenta uma cópia completa. Por exemplo, um estado de 500 KB sincronizado 100 vezes utiliza aproximadamente 50 MB, além de metadados. O programa baixa apenas os últimos arquivos de cada dispositivo, mas lista os arquivos históricos e não faz limpeza automática. Um snapshot individual tem limite de 25 MB nesta versão.

Conserve também um backup exportado fora do navegador. O Google permite que o usuário remova os dados da pasta do aplicativo ou que a pasta seja apagada ao remover a aplicação do Drive. A sincronização não deve ser sua única cópia. [Ciclo de vida da pasta do aplicativo](https://developers.google.com/workspace/drive/api/guides/appdata).

## Detalhes das alternativas

### Google Sheets

A API permite ler/escrever planilhas diretamente do navegador. O escopo recomendado `drive.file` autoriza apenas arquivos criados/selecionados para o aplicativo e é não sensível. Os escopos `spreadsheets` e `spreadsheets.readonly`, que alcançam todas as planilhas, são sensíveis. Para adotar Sheets neste projeto, seria melhor criar uma planilha própria com `drive.file`, em vez de pedir acesso a todas as planilhas da conta. [Escopos do Sheets](https://developers.google.com/workspace/sheets/api/scopes).

O uso padrão é sem custo adicional. As quotas atuais incluem 300 requests de leitura e 300 de escrita por minuto por projeto e 60 de cada por minuto por usuário/projeto. A documentação também anuncia cobrança futura para uso acima das quotas. Essas quotas são suficientes para um orçamento pessoal, usando operações em lote. Sheets seria útil para inspecionar dados manualmente, mas demandaria definir a estrutura e o comportamento de edições externas. [Limites e preço do Sheets](https://developers.google.com/workspace/sheets/api/limits).

### OneDrive

O Microsoft Graph oferece uma pasta do aplicativo em `Apps/{nome do aplicativo}`, com o escopo `Files.ReadWrite.AppFolder`, usando o espaço disponível da conta. Para contas Microsoft pessoais, a documentação do endpoint de pastas especiais indica esse escopo como o mínimo para a pasta do aplicativo. O usuário pode alterar/remover arquivos dessa pasta. [Pasta do aplicativo](https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder), [permissões para contas pessoais](https://learn.microsoft.com/en-us/graph/api/drive-get-specialfolder?view=graph-rest-1.0).

Uma integração de navegador requer registrar a aplicação no Microsoft Entra e usar código de autorização com **PKCE**, sem Client Secret no frontend. Em aplicações SPA, os refresh tokens duram 24 horas; a aplicação precisa renovar a autorização depois disso. A conta Office existente pode tornar essa opção atraente, mas a integração Microsoft Graph não está implementada no Budget. [Fluxo SPA e PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/reference-third-party-cookies-spas), [validade dos tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens).

### Supabase Free

O plano gratuito atual permite dois projetos e inclui banco de 500 MB por projeto, armazenamento de arquivos de 1 GB e tráfego de 5 GB. Esses volumes atendem bem um orçamento pessoal. Seria necessário implementar autenticação, esquema de tabelas e políticas de acesso para restringir os dados ao seu usuário. [Plano gratuito e limites](https://supabase.com/docs/guides/platform/billing-on-supabase).

A principal limitação para este caso é a pausa automática por pouca atividade em um período de sete dias. Uma aplicação usada só na revisão mensal pode precisar que você reative o projeto no painel. Por isso o Drive se adapta melhor ao uso esporádico sem servidor próprio. [Pausa de projetos](https://supabase.com/docs/guides/platform/free-project-pausing).

## Rodar localmente ou publicar

Para rodar em outro computador, clone o código e use os comandos do README. O navegador acessa os dados privados diretamente no Drive após sua autorização. O computador não precisa de banco de dados nem backend próprio.

Um frontend estático pode tecnicamente ser hospedado, mas hospedagem é uma configuração separada. Em GitHub Free, o GitHub Pages exige repositório público. Sites Pages são públicos mesmo quando a origem permite repositório privado. O GitHub orienta não usar Pages para transações sensíveis como envio de senhas ou números de cartão. Esta versão tem execução local como padrão e não inclui dados pessoais no código publicado. [Disponibilidade e funcionamento do Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages), [HTTPS e restrições](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https).

Se futuramente configurar uma origem HTTPS, cadastre **a origem**, por exemplo `https://seu-dominio`, no OAuth. Caminhos de repositório não fazem parte da origem. O armazenamento local de uma origem HTTPS é separado do de localhost; conecte e sincronize para recuperar seus dados.

## Problemas comuns

| Mensagem/situação | Como resolver |
| --- | --- |
| Origem não autorizada / `origin_mismatch` | Abra `http://localhost:5173` e confira se tanto `http://localhost` quanto `http://localhost:5173` estão nas origens do cliente Web |
| Aplicativo em Testing bloqueia sua conta | Adicione o email exato em Test users; conclua a janela com essa conta |
| Autorização voltou a ser pedida | Tokens do navegador são temporários; em Testing, o consentimento também expira em sete dias |
| Janela do Google não abriu | Permita pop-ups para a origem do aplicativo e clique em conectar novamente |
| Drive recusou acesso | Confirme que a Google Drive API está habilitada e autorize o escopo da pasta do aplicativo |
| Falha de internet ou timeout | Seus dados locais continuam salvos. Reconecte/sincronize quando a internet voltar |
| Nenhum dado aparece em outro computador | Use a mesma conta Google e o mesmo Client ID; confirme uma sincronização concluída no primeiro computador |
| Backup remoto inválido | O programa interrompe o envio para não propagar erro. Exporte os dados locais e investigue o backup antes de restaurar |
| Falta de espaço na conta Google | Libere espaço ou use os backups locais; o Budget não contrata armazenamento nem remove arquivos automaticamente |
