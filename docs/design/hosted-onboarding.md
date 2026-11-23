# 호스팅 베타: 연결 흐름과 사용량 제한 설계

> 작성일: 2026-11-23 · 상태: 1단계(사용량 제한)와 2단계(/connect) 구현됨 · 관련: [PLAN.md](../../PLAN.md) 0장 "딸깍", 7장 호스팅 버전, [server-agent.md](server-agent.md)

## 목표

다른 사람이 **아무것도 배포하지 않고** 쓰게 한다. 사용자가 하는 일은 세 가지다.

```
① 우리 Discord 봇을 서버에 초대
② 서버에서 /connect 실행 → 열린 링크에서 우리 GitHub App을 저장소에 설치
③ 끝. 신고 → 이슈 → agent:go → Draft PR
```

이번 범위는 **비공개 베타**다. 초대 코드를 받은 몇 팀만 쓰고, AI 비용은 우리가 낸다. 그래서 **서버별 사용량 제한이 연결 흐름과 같은 무게의 필수 항목**이다.

**이번 범위가 아닌 것**: 웹 대시보드, 결제, 고객 API 키 등록(BYOK), 서버 하나에 저장소 여러 개.

## 설계 전 상태 (2026-11-23)

- Discord 서버와 저장소 연결은 `scripts/seed.sql`로 **직접 SQL을 넣는 방식뿐**이었다 (`discord_guilds`, `github_repos`)
- `github_repos`의 기본 키가 `tenant_id`라서 테넌트 하나에 저장소 하나다. 베타는 이 제약을 그대로 쓴다
- 에이전트 실행은 웹훅의 `owner/repo`로 테넌트를 찾는다 (`src/agent/runs.ts`). 같은 저장소를 두 테넌트가 등록하는 것을 막는 제약이 없었다
- GitHub App과 Discord 봇은 비공개(본인 계정 전용)다

## 전체 흐름 (구현된 모양)

처음 설계는 "설치 → Setup URL의 `installation_id`를 사용자 토큰으로 확인"이었다. 구현하면서 **GitHub 로그인을 먼저 하고, 사용자 토큰으로 이 앱의 설치와 저장소 목록을 직접 받는 방식**으로 바꿨다. 이렇게 하면 브라우저가 보낸 `installation_id`를 어디에도 쓰지 않고, 이미 앱을 설치한 사용자는 설치 화면을 거치지 않는다.

```
[Discord] 관리자가 /connect (베타: /connect code:<초대 코드>)
   │  Worker: 서버 관리 권한 확인 → 초대 코드 확인 → 1회용 링크 (30분)
   ▼
[브라우저] /connect/start?t=<링크 토큰>
   │  링크를 사용 처리 → 새 브라우저 토큰을 쿠키로 → GitHub 로그인(OAuth)으로, state = 브라우저 토큰
   ▼
[GitHub] 로그인·승인 → /connect/github/callback?code=…&state=…
   │  Worker: state == 쿠키 확인 → code를 사용자 토큰으로 교환
   │  → GET /user/installations, /user/installations/{id}/repositories (사용자 토큰)
   │  → 관리자 권한이 있는 저장소만 후보로 저장 → 사용자 토큰 폐기(revoke)
   │
   ├─ 후보가 없음 → 앱 설치 화면(github.com/apps/<slug>/installations/new)으로
   │      설치 후 GitHub → Setup URL /connect/github/setup → 다시 로그인 → 콜백
   ▼
[확인 화면] "Discord 서버 <이름>를 저장소에 연결합니다" + 저장소 선택 + [연결]
   │  POST /connect/github/confirm: 폼 토큰 == 쿠키, 고른 저장소가 저장된 후보에 있는지 확인
   ▼
[Worker] 한 트랜잭션으로 저장 → agent:go 라벨 생성 → 채널에 "owner/repo에 연결되었습니다"
```

**확인 화면에 서버 이름을 항상 보여 주는 이유**: 공격자가 자기 서버에서 `/connect`를 실행하고 그 링크를 피해자(저장소 관리자)에게 보내면, 피해자가 모르고 자기 저장소를 공격자 서버에 연결할 수 있다. 저장소가 하나여도 바로 연결하지 않고, 어느 서버에 연결하는지 보여 준 뒤 버튼을 누르게 한다.

## 단계별 설계

### 1. `/connect` 명령 (Discord) — `src/connect/command.ts`

- 명령 등록 시 `default_member_permissions: "32"`(서버 관리, MANAGE_GUILD). 관리자(Administrator)는 항상 쓸 수 있다
- 서버에서 권한을 바꿀 수 있으므로, **Worker가 직접 다시 확인한다**: 인터랙션의 `member.permissions`에 MANAGE_GUILD(`1 << 5`) 또는 ADMINISTRATOR(`1 << 3`)가 없으면 거절
- `contexts: [0]`(서버 안에서만)
- 옵션 `code`: `CONNECT_INVITE_REQUIRED=true`일 때만 확인. `invite_codes`에서 남은 사용 횟수를 본다
- 이미 연결된 서버면 현재 저장소를 알려 주고, 끝까지 진행하면 **바꾼다** (`/disconnect`는 3단계)
- 아직 연결되지 않은 서버에서도 동작한다 (`/bug`의 연결 확인보다 먼저 처리)
- 응답은 본인에게만 보이는(ephemeral) 메시지와 링크 버튼

**링크 토큰**: 서명 대신 32바이트 무작위 값을 `connect_sessions`에 저장한다. 추측할 수 없고, 서버 쪽에서 만료(30분)와 1회 사용을 확인하므로 서명 키가 따로 필요 없다. 링크를 여는 순간 **다른 무작위 값(브라우저 토큰)**을 새로 만들어 쿠키에 넣는다. 그래서 채팅에 남은 링크가 나중에 새어도 다시 쓸 수 없다.

### 2. `/connect/start`

- 링크 토큰이 있고, 아직 열리지 않았고, 만료 전이면 사용 처리 (한 문장으로 `UPDATE … RETURNING`)
- 쿠키 `__Host-ftp_connect=<브라우저 토큰>` (Path=/, HttpOnly, Secure, SameSite=Lax, 30분)
- GitHub OAuth 화면으로 302, `state` = 브라우저 토큰

### 3. OAuth 콜백 `/connect/github/callback`

1. 쿠키로 열린 세션을 찾고, `state`가 쿠키와 같은지 확인. 다르면 GitHub에 아무 요청도 하지 않고 끝낸다
2. `code`를 사용자 토큰으로 교환 (앱 Client ID, Client Secret)
3. 사용자 토큰으로 `GET /user/installations`(이 앱의 설치 중 사용자가 접근 가능한 것)와 각 설치의 저장소를 받는다. `permissions.admin`이 true인 저장소만 후보로 남긴다 (설치 20개, 설치당 300개까지)
4. 사용자 토큰을 **폐기**(`DELETE /applications/{client_id}/token`)하고 저장하지 않는다
5. 후보를 세션에 저장. 없으면 앱 설치 화면으로 보낸다

### 4. 확인 `/connect/github/confirm` (POST)

- 쿠키 세션 + 폼의 토큰이 쿠키와 같은지 확인 (double submit). 쿠키가 SameSite=Lax라 다른 사이트의 POST에는 쿠키가 붙지 않는다
- 고른 저장소가 **저장된 후보 목록에 있는지** 확인. 폼 값을 그대로 믿지 않는다
- 저장 (`D1ConnectStore.link`):
  1. 세션을 완료 처리 (두 번 눌러도 한 번만 연결)
  2. 초대 코드 사용 횟수 +1 (남은 횟수가 있을 때만)
  3. `db.batch` 한 트랜잭션으로 `tenants`(없으면 생성, 서버가 이미 있으면 그 테넌트를 다시 씀), `discord_guilds`, `github_repos`(테넌트의 저장소를 바꿈)
  4. 다른 서버가 이미 연결한 저장소면 unique 인덱스에 걸린다 → 세션과 초대 코드를 되돌리고 "이미 다른 서버에 연결됨"
- 연결 뒤(실패해도 연결은 유지, 로그만): 저장소에 `agent:go` 라벨 생성, `/connect`를 실행한 채널에 연결 완료 메시지
- 화면은 `Cache-Control: no-store`, `X-Frame-Options: DENY`, CSP(`form-action 'self'`, `frame-ancestors 'none'`), `Referrer-Policy: no-referrer`

### Setup URL `/connect/github/setup`

앱을 새로 설치한 뒤 GitHub가 보내는 주소. 붙어 오는 `installation_id`는 **쓰지 않는다** (GitHub 문서도 위조될 수 있다고 경고). 쿠키 세션이 있으면 다시 로그인시켜 콜백에서 목록을 새로 받는다.

### 5. 연결 해제

| 계기 | 처리 |
|---|---|
| `/disconnect` (서버 관리 권한) | 그 서버의 `discord_guilds` 행 삭제. 테넌트에 남은 서버가 없으면 `github_repos`도 삭제 |
| GitHub `installation` 웹훅 `deleted` | 그 `installation_id`의 `github_repos` 행 삭제 |
| GitHub `installation_repositories` 웹훅 `removed` | 빠진 저장소의 행 삭제 |
| `installation` `suspend` | 행은 두고, 이슈 생성과 에이전트 실행 전에 막는다 |
| 봇이 서버에서 추방됨 | **알 방법이 없다.** Discord HTTP 웹훅 이벤트에는 서버에서 봇을 내보낸 이벤트가 없다 (`APPLICATION_DEAUTHORIZED`는 사용자 정보만 담음). 인터랙션이 더 오지 않으므로 남은 행은 해가 없다. 봇 API 호출이 403/404면 그때 정리한다 |

`installation`, `installation_repositories` 웹훅은 GitHub App에 따로 구독하지 않아도 오는 것으로 알고 있다. 구현할 때 문서로 확인한다.

### 6. 사용량 제한

베타는 우리 키로 AI를 돌리므로, 제한이 없으면 공개 서버 하나가 비용을 끝없이 만들 수 있다.

| 제한 | 베타 기본값 (설정 가능) | 확인 시점 | 넘으면 |
|---|---|---|---|
| 신고자별 | 1시간에 5건 | `/bug` 제출 직후 (Queue에 넣기 전) | 본인에게만 보이는 안내 |
| 서버(테넌트)별 월 신고 | 월 200건 | `/bug` 제출 직후 (Queue에 넣기 전) | 신고를 받지 않고 본인에게만 보이는 안내 (2026-11-23 결정) |
| 테넌트별 월 에이전트 실행 | 월 10회 | `agent:go` 처리에서 세션 생성 전 | 이슈에 "이번 달 한도 도달" 댓글, 라벨 `agent:failed` |
| 실행 1회 비용 | $2 (`AGENT_BUDGET_CENTS`, 이미 있음) | 플랫폼이 강제 | 실행 중지 |

**최악의 경우 비용 (추정)**: 테넌트 하나에 월 200건 × $0.03 + 10회 × $2 = **약 $26/월**. 베타 10팀이면 약 $260/월이 상한이다. 분류를 Haiku로 바꾸면 분류 몫은 거의 0이 된다.

**기록**: `tenant_usage (tenant_id, period 'YYYY-MM', reports, agent_runs)`. 확인과 증가를 한 문장(`INSERT … ON CONFLICT DO UPDATE … WHERE count < limit RETURNING`)으로 해서 동시에 들어온 요청이 한도를 넘지 않게 한다. 받아들인 일만 센다: 잘못된 입력이나 권한 없는 `agent:go`처럼 앞 단계에서 거절된 것은 세지 않는다. 세션이 끝날 때 토큰 사용량도 같이 적어 두면 나중에 요금제 가격을 정할 근거가 된다 (이후 작업).

셀프 호스팅에도 그대로 쓴다. 설정하지 않으면 "제한 없음"이라 지금 동작이 바뀌지 않는다. 한도가 없어도 사용량은 센다.

**구현됨 (2026-11-23)**: `migrations/0005_usage.sql`, `src/core/usage.ts`, `src/db/usage.ts`. 설정은 `LIMIT_REPORTS_PER_USER_HOUR`, `LIMIT_REPORTS_PER_MONTH`, `LIMIT_AGENT_RUNS_PER_MONTH`.

## 데이터 변경

- migration 0005 (`tenant_usage`): 위 "사용량 제한"
- migration 0006 (`migrations/0006_connect.sql`): `github_repos`의 `(lower(owner), lower(repo))` unique 인덱스와 `installation_id` 인덱스, `connect_sessions`(링크 토큰, 브라우저 토큰, 서버·채널·사용자, 언어, 초대 코드, 후보 저장소 JSON, 만료·시작·완료 시각), `invite_codes`

`tenants.plan`은 아직 쓰는 곳이 없어 넣지 않았다 (요금제를 만들 때 추가). 기존 셀프 호스팅 데이터는 그대로 남는다.

## 새 설정값

| 이름 | 용도 |
|---|---|
| `PUBLIC_BASE_URL` | 링크와 콜백 주소 (`https://feedback-to-pr.<account>.workers.dev` 또는 자체 도메인) |
| `GITHUB_APP_SLUG` | 설치 화면 주소 `github.com/apps/<slug>/installations/new` |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | 사용자 인증 (GitHub App 설정 페이지) |
| `CONNECT_INVITE_REQUIRED` | `true`면 `/connect`에 초대 코드가 필요 (비공개 베타) |
| `LIMIT_REPORTS_PER_USER_HOUR`, `LIMIT_REPORTS_PER_MONTH`, `LIMIT_AGENT_RUNS_PER_MONTH` | 사용량 제한. 비워 두면 제한 없음 |

앞의 네 개가 모두 있어야 `/connect`가 켜진다. 하나라도 없으면 `/connect`는 "설정되어 있지 않다"고 답하고, `/connect/*` 주소는 404다.

**초대 코드 만들기** (베타):

```sh
npx wrangler d1 execute feedback-to-pr --remote --command "INSERT INTO invite_codes (code, max_uses, note) VALUES ('<코드>', 1, '<누구에게 줬는지>')"
```

## 외부 설정 (사람이 직접)

**GitHub App** (Settings → Developer settings → GitHub Apps → 앱)
- General → **Callback URL**: `https://<worker>/connect/github/callback`
- General → **Setup URL**: `https://<worker>/connect/github/setup`, "Redirect on update" 켜기
- "Request user authorization (OAuth) during installation"은 **끈다** (우리 흐름이 로그인을 직접 한다)
- General → Client secrets → **Generate a new client secret** → `GITHUB_APP_CLIENT_SECRET`
- Client ID → `GITHUB_APP_CLIENT_ID`, 앱 주소의 이름 → `GITHUB_APP_SLUG`
- 공개 전환(4단계): Advanced → "Make public" (Any account)

**Discord 애플리케이션**
- `npm run register-commands`로 `/connect` 명령을 등록
- 공개 전환(4단계): Bot → **Public Bot** 켜기, Installation → Guild Install만, 범위 `bot`, `applications.commands`, 명령을 전역 등록

**Anthropic**: 베타 비용 상한을 Console에서 조직 단위로도 걸어 둔다 (이중 안전장치)

## 보안 점검

| 위협 | 막는 방법 | 테스트 |
|---|---|---|
| 남의 저장소를 내 Discord 서버에 연결 | 저장소 목록을 사용자 토큰으로만 받고, 관리자 권한이 있는 것만 후보로. 브라우저가 보낸 `installation_id`는 쓰지 않음 | 관리자 아닌 저장소 제외, 후보에 없는 저장소 거절 |
| 링크를 피해자에게 보내 피해자 저장소를 내 서버에 연결 | 확인 화면에 연결될 Discord 서버 이름을 항상 보여 주고 버튼을 누르게 함 | 서버 이름 표시(HTML 이스케이프) |
| 남의 Discord 서버를 내 저장소에 연결 | `/connect`는 서버 관리 권한 필요. Worker가 `member.permissions`를 다시 확인 | 권한 없음·누락·다른 권한만 있음 거절, 관리자 허용 |
| 링크 가로채기, 재사용 | 30분 만료, 1회용 링크, 열 때 새 브라우저 토큰, 쿠키와 `state` 일치 | 두 번째 열기 거절, state 불일치 시 GitHub 호출 없음 |
| 연결 화면 CSRF | 폼 토큰 == 쿠키 (double submit), SameSite=Lax 쿠키, CSP `form-action 'self'` | 위조 토큰 거절 |
| 같은 저장소 이중 연결 | 대소문자 무시 unique 인덱스, 실패 시 세션·초대 코드 되돌림 | 로컬 D1에서 확인 |
| 두 번 제출 | 세션 완료를 먼저 처리 | 두 번째 제출 거절 |
| 사용자 토큰 유출 | 저장하지 않고 쓴 직후 폐기 | 폐기 호출 확인 |
| 서버 이름으로 HTML 주입 | 모든 값 이스케이프, CSP `default-src 'none'` | `<script>` 이름 테스트 |
| 공개 서버의 신고 폭탄 | 신고자별, 테넌트별 제한 (1단계) | |
| 우리가 다른 고객의 데이터를 봄 | 호스팅 운영자는 마스킹된 신고를 볼 수 있다. 개인정보처리방침에 적고, 신고 보관 기간(예: 90일) 뒤 삭제 작업을 둔다 | |

## 구현 순서 (PR 단위)

1. **사용량 제한** ✅: migration 0005의 `tenant_usage`, 신고자별 제한, 신고 접수와 에이전트 실행 전 확인. 셀프 호스팅에도 바로 쓸모가 있다
2. **연결 흐름** ✅: `/connect`, `/connect/start`, OAuth 콜백, 확인 화면, Setup URL, 연결 완료 메시지, 라벨 생성. `connect_sessions`, `invite_codes`, unique 인덱스 (`src/connect/`)
3. **해제와 상태**: `/disconnect`, `/status`(연결된 저장소, 이번 달 사용량), `installation` 웹훅 처리
4. **공개 전환**: GitHub App·Discord 봇 공개 설정, 전역 명령 등록, 이용약관·개인정보처리방침 페이지, README에 "설치하기" 안내

덤으로, 2번으로 **셀프 호스팅도 `seed.sql` 없이** `/connect`로 연결할 수 있다.

## 정해야 할 것

1. ~~월 분류 한도를 넘었을 때~~ → 신고를 받지 않고 안내 (2026-11-23 결정)
2. ~~베타 한도 숫자~~ → 신고자 시간당 5건, 월 200건, 월 실행 10회로 시작 (2026-11-23 결정, 배포에 설정됨)
3. **도메인**: `workers.dev` 그대로 갈지, 자체 도메인을 붙일지. OAuth 화면과 링크에 주소가 그대로 보이므로 공개 전에는 자체 도메인을 추천
4. **신고 보관 기간**: 예: 90일 뒤 삭제
5. **Discord 봇 인증 기준**: 봇이 일정 수 이상의 서버에 들어가면 Discord 인증이 필요하다. 기준 숫자와 요구 사항은 문서에서 확인하지 못했다 (지원 문서 접근 불가). Developer Portal의 App Verification 페이지에서 확인 필요

## 확인 결과 (2026-11-23, 공식 문서)

| 질문 | 결과 |
|---|---|
| Setup URL의 `installation_id`를 믿어도 되나 | **안 된다.** GitHub 문서가 위조 가능하다고 경고하고, 사용자 토큰으로 확인하라고 권장 |
| 사용자가 접근 가능한 설치·저장소 확인 | `GET /user/installations`, `GET /user/installations/{id}/repositories`. 사용자가 실제 권한을 가진 것만 돌려줌, 저장소별 `permissions` 포함 |
| 설치 화면에 `state` 전달 | **확인 못 함** → 쿠키로 세션 유지 |
| "설치 중 사용자 인증 요청" 옵션의 동작 | **확인 못 함** → 구현 시 시험 |
| Discord 봇 초대에 redirect가 필요한가 | 필요 없음. 일반 초대 링크는 `client_id`, `scope`, `permissions`만으로 됨 |
| 봇이 서버에서 추방된 것을 HTTP로 알 수 있나 | **없음.** 웹훅 이벤트는 `APPLICATION_AUTHORIZED`(서버 설치 시 guild 포함), `APPLICATION_DEAUTHORIZED`(사용자만), 엔티틀먼트 등 |
| 명령 권한 | `default_member_permissions`는 권한 비트를 문자열로 (MANAGE_GUILD = "32"). 관리자는 항상 사용 가능, 서버에서 덮어쓰기 가능 → 서버 쪽 재확인 필요 |
| 봇 인증 기준 서버 수 | **확인 못 함** |
