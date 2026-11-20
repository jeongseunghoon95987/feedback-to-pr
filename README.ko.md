# feedback-to-pr

[English](README.md)

> **상태: 초기 개발 중, 셀프 호스팅.** Discord 신고가 AI 분류를 거쳐 GitHub 이슈가 되고, 이슈에 `agent:go` 라벨을 붙이면 서버 쪽 에이전트(Claude Managed Agents)가 Draft PR을 만듭니다. 진행 상황 스레드, 머지 후 답장, 사용자별 신고 횟수 제한, 호스팅 버전은 아직 없습니다. 설계는 [PLAN.md](PLAN.md)를 참고하세요. 로컬 개발 환경 설정은 [README.md](README.md#development)에 있습니다.

Discord 커뮤니티에 올라온 버그 신고를 정리된 GitHub 이슈로 만들고, 메인테이너가 승인하면 AI 코딩 에이전트가 PR을 열고, 수정이 반영되면 신고한 사람에게 알려줍니다.

## 왜 필요한가

코딩 에이전트는 이미 이슈를 PR로 바꿀 수 있고, Slack, Jira, Linear 같은 도구도 이미 에이전트와 연결되어 있습니다. 하지만 이건 **내부 도구**입니다. 글을 쓰는 사람이 팀원입니다.

사용자의 버그 신고는 다른 곳으로 들어옵니다. Discord 서버, 고객 상담 채팅, 피드백 폼 같은 곳입니다. 이런 입력은 **믿을 수 없습니다**. 개인정보, 스팸, 중복 신고가 섞이고, AI 에이전트를 조종하려고 쓴 문장이 들어올 수도 있습니다. feedback-to-pr는 그 입력과 저장소 사이에서 안전하게 넘겨주는 역할을 합니다.

## 동작 방식

```
Discord  /bug  또는  메시지 우클릭 → "버그로 신고"
   │
   ▼
Cloudflare Worker   서명 검증 → 개인정보 마스킹 → 신고 횟수 제한
   │  (Queue)
   ▼
분류                 요약, 분류(버그 / 기능 요청 / 문의 / 스팸),
                    중복 확인 → GitHub 이슈 생성 또는 기존 이슈에 댓글
   │
   ▼
GitHub 이슈          메인테이너가 `agent:go` 라벨을 붙임   ← 사람 승인
   │
   ▼
코딩 에이전트         Claude Managed Agents가 저장소를 읽고 패치를 만듦,
                    Worker가 패치를 검사한 뒤 GitHub App으로 Draft PR 생성
   │
   ▼
머지                 봇이 신고자의 Discord 스레드에 답장 (예정)
```

## 원칙

- **신고 내용은 데이터일 뿐, 지시가 아닙니다.** 원문은 신뢰하지 않는 입력으로 인용하고, 에이전트에게 그 안의 지시를 따르지 말라고 명시합니다.
- **사람 승인 없이 에이전트를 돌리지 않습니다.** 메인테이너가 승인 라벨을 붙이기 전에는 코드에 손대지 않습니다.
- **개인정보를 이슈에 남기지 않습니다.** 이메일, 전화번호 등은 이슈를 만들기 전에 가립니다.
- **최소 권한.** PR 코드를 실행하는 작업에는 비밀키를 주지 않습니다. GitHub App은 필요한 권한만 요청합니다.
- **에이전트는 직접 고릅니다.** feedback-to-pr는 이슈를 준비하고, 수정은 원하는 코딩 에이전트가 합니다.

## 계획 범위

**v0.1 (셀프 호스팅)**
- Discord: `/bug` 입력 창, 메시지 우클릭 신고
- 개인정보 마스킹, 사용자별 신고 횟수 제한
- AI 분류와 중복 확인
- GitHub App 인증
- 승인 라벨 워크플로 템플릿
- PR이 열리고 머지될 때 Discord 스레드에 답장
- 한국어·영어 설치 가이드

**이후**
- 웹 피드백 폼, 채널톡, Intercom, 이메일
- 설치 버튼만 누르면 되는 호스팅 버전

## 배포 (셀프 호스팅)

Cloudflare 계정, Discord 애플리케이션, GitHub App, Claude API 키가 필요합니다. 모두 본인 계정에서 돌아갑니다. 명령어는 [README.md의 Deploy](README.md#deploy-self-hosted)와 같습니다.

1. **Discord 애플리케이션** ([개발자 포털](https://discord.com/developers/applications)): Application ID와 Public Key를 복사하고 봇 토큰을 만듭니다.
2. **GitHub App** (Settings → Developer settings → GitHub Apps)
   - 저장소 권한: Issues, Contents, Pull requests는 읽기·쓰기, Metadata는 읽기. Workflows 권한은 주지 않습니다.
   - 웹훅: Active, URL `https://<내 Worker>/github/webhook`(4단계 뒤에 넣어도 됩니다), 임의의 시크릿, **Issues** 이벤트 구독.
   - 비밀키를 만들고, 대상 저장소에 앱을 설치한 뒤 설치 번호(설치 페이지 주소 끝의 숫자)를 적어 둡니다.
3. **Claude**: `.dev.vars`에 `ANTHROPIC_API_KEY`를 넣고 `npm run setup-agent`를 한 번 실행합니다. `MANAGED_AGENT_ID`와 `MANAGED_ENVIRONMENT_ID`가 출력됩니다.
4. **Cloudflare**: `wrangler login` → D1·Queue 생성 → `npm run db:migrate:remote` → `scripts/seed.sql`에 Discord 서버 id와 저장소를 넣어 `--remote`로 실행 → `npm run deploy`. 비밀값은 `npx wrangler secret put <이름>`으로 넣습니다.
5. **각 서비스에 Worker 주소 등록**
   - Discord 포털 → Interactions Endpoint URL: `https://<내 Worker>/discord/interactions` (Discord가 저장 전에 주소를 확인하므로 배포가 먼저입니다)
   - GitHub App → Webhook URL: `https://<내 Worker>/github/webhook`
   - Claude Console → Webhooks: `https://<내 Worker>/anthropic/webhook`, 이벤트 `session.status_idled`, `session.status_terminated`, `session.budget_reached`. 표시되는 서명 키를 `npx wrangler secret put ANTHROPIC_WEBHOOK_SIGNING_KEY`로 넣습니다.
   - `npm run register-commands`로 `/bug` 명령을 등록합니다.

서버에서 `/bug`로 시험해 보세요. 짧은 테스트 문구는 보통 스팸으로 분류되어 이슈 없이 닫히고, 구체적인 신고는 이슈가 됩니다. 그 이슈에 `agent:go`를 붙이면 Draft PR이 만들어집니다. `npx wrangler tail`로 들어오는 요청을 볼 수 있습니다.

## 비용

feedback-to-pr 자체는 무료(MIT)입니다. 셀프 호스팅하면 Cloudflare와 Anthropic에 직접 냅니다. 아래 단가는 2026-11-20에 확인한 정가이고, 신고·실행 1건당 금액은 측정값이 아니라 추정입니다.

| 항목 | 단가 | 보통 사용량 |
|---|---|---|
| Cloudflare Workers, D1, Queues | 무료 플랜: 하루 요청 100,000건, Queue 작업 하루 10,000건(신고 1건에 약 3작업), D1 5GB. 유료 플랜: 월 $5 | 커뮤니티 프로젝트는 무료 플랜으로 충분 |
| AI 분류 (신고 1건마다) | Claude Opus 5.5, low effort: 입력·출력 100만 토큰당 $4 / $20 | 신고 1건에 약 $0.03 (입력 약 3천, 출력 약 1천 토큰 가정) |
| 에이전트 실행 (`agent:go` 1번마다) | Claude Opus 5.5 토큰 + 세션 실행 중인 시간 1시간당 $0.08 | `AGENT_BUDGET_CENTS`로 1회 상한 설정(기본 $2). 상한에 닿으면 실행이 멈춤 |

비용을 줄이려면:
- `TRIAGE_MODEL=claude-haiku-5-5`로 바꾸면 분류 비용이 신고당 1센트보다 훨씬 적어집니다(100만 토큰당 $0.10 / $0.50). Haiku의 분류 품질은 아직 측정하지 않았습니다.
- `AGENT_BUDGET_CENTS`를 낮춥니다. 상한이 낮으면 어려운 이슈는 패치 없이 멈출 수 있습니다.
- 스팸은 이슈를 만들기 전에 걸러지고, 에이전트는 메인테이너가 승인한 뒤에만 돌아갑니다.

## 호스팅 버전 요금제 (초안)

호스팅 버전(v0.3 예정)은 직접 배포하고 싶지 않은 사람을 위한 것입니다. GitHub App과 Discord 봇을 버튼으로 설치하고, 채널과 저장소를 연결하면 끝납니다. 셀프 호스팅은 계속 무료이고 기능도 같습니다. 아래 내용은 아직 정해지지 않았습니다.

**수익 구조**
- **월 구독**: 서비스 자체에 대한 요금입니다. 호스팅, 우리 GitHub App과 Discord 봇, 대시보드, 지원이 포함됩니다.
- **AI 사용료는 따로 받습니다.** 많이 쓰는 고객 때문에 손해가 나지 않게 하려는 것입니다.
  - **자기 키 사용** (기본): 사용자가 Claude API 키를 입력하고 Anthropic이 사용자에게 직접 청구합니다. 우리는 수수료를 붙이지 않습니다.
  - **크레딧**: 키를 관리하기 싫은 사용자는 선불 크레딧을 삽니다. 사용량을 정가에 마진을 더해 차감하고, 저장소마다 월 한도를 둡니다.

**요금제 초안** (예시 숫자. 실제 비용을 측정한 뒤 정합니다)

| | Free | Pro | Team |
|---|---|---|---|
| 가격 | $0 | 월 약 $10 | 월 약 $30 |
| 저장소, Discord 서버 | 1개, 1개 | 5개, 3개 | 제한 없음 |
| 월 분류 신고 수 | 100건 | 2,000건 | 10,000건 |
| 에이전트 실행 | 자기 키만 | 자기 키 또는 크레딧 | 자기 키 또는 크레딧, 저장소별 한도 |

**먼저 만들어야 할 것**
- 테넌트별 사용량 기록: 신고 수, 분류 토큰, 에이전트 세션 1건당 비용(세션이 끝날 때 사용량을 읽음). 테이블에는 이미 `tenant_id`가 있습니다.
- 분류와 에이전트 실행 전에 요금제 한도 확인.
- 결제(예: Stripe) 연동, 고객 API 키 암호화 저장.
- 이용약관, 개인정보처리방침, 처리 위탁 관계 정리. 마스킹을 해도 신고에 개인정보가 남을 수 있습니다.

## 기술 스택

Cloudflare Workers, Queues, D1 · TypeScript · GitHub App · 분류용 Claude API

## 라이선스

[MIT](LICENSE)
