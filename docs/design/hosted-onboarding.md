# 호스팅 베타: 연결 흐름과 사용량 제한 설계

> 작성일: 2026-11-23 · 상태: 설계 (구현 전) · 관련: [PLAN.md](../../PLAN.md) 0장 "딸깍", 7장 호스팅 버전, [server-agent.md](server-agent.md)

## 목표

다른 사람이 **아무것도 배포하지 않고** 쓰게 한다. 사용자가 하는 일은 세 가지다.

```
① 우리 Discord 봇을 서버에 초대
② 서버에서 /connect 실행 → 열린 링크에서 우리 GitHub App을 저장소에 설치
③ 끝. 신고 → 이슈 → agent:go → Draft PR
```

이번 범위는 **비공개 베타**다. 초대 코드를 받은 몇 팀만 쓰고, AI 비용은 우리가 낸다. 그래서 **서버별 사용량 제한이 연결 흐름과 같은 무게의 필수 항목**이다.

**이번 범위가 아닌 것**: 웹 대시보드, 결제, 고객 API 키 등록(BYOK), 서버 하나에 저장소 여러 개.

## 지금 상태 (2026-11-23 코드 기준)

- Discord 서버와 저장소 연결은 `scripts/seed.sql`로 **직접 SQL을 넣는 방식뿐**이다 (`discord_guilds`, `github_repos`)
- `github_repos`의 기본 키가 `tenant_id`라서 테넌트 하나에 저장소 하나다. 베타는 이 제약을 그대로 쓴다
- 에이전트 실행은 웹훅의 `owner/repo`로 테넌트를 찾는다 (`src/agent/runs.ts`). 같은 저장소를 두 테넌트가 등록하는 것을 막는 제약은 없다
- 사용량 제한은 없다. 신고자별 조회용 인덱스(`reports_reporter_created`)만 있다
- GitHub App과 Discord 봇은 비공개(본인 계정 전용)다

## 전체 흐름

```
[Discord] 관리자가 /connect code:<초대 코드>
   │  Worker: 서버 관리 권한 확인 → 초대 코드 확인 → 1회용 링크 생성 (10분)
   ▼
[브라우저] https://<worker>/connect/start?t=<서명된 토큰>
   │  토큰 검증 → 연결 세션 쿠키 설정 → GitHub 앱 설치 화면으로 이동
   ▼
[GitHub] 사용자가 저장소를 고르고 설치
   │  GitHub → Setup URL: /connect/github/setup?installation_id=…
   ▼
[Worker] installation_id는 믿지 않는다. 연결 세션에 임시로 적어 두고
   │  GitHub 사용자 인증(OAuth)으로 다시 보냄
   ▼
[GitHub] 사용자 인증 → /connect/github/callback?code=…&state=…
   │  Worker: state 확인 → 사용자 토큰으로 "이 사용자가 이 설치의 이 저장소에 관리자 권한이 있는지" 확인
   │  → 저장소가 여러 개면 고르는 화면 → 저장
   ▼
[Discord] 봇이 /connect를 실행한 채널에 "owner/repo에 연결되었습니다" 메시지
```

## 단계별 설계

### 1. `/connect` 명령 (Discord)

- 명령 등록 시 `default_member_permissions: "32"`(서버 관리, MANAGE_GUILD). 관리자(Administrator)는 항상 쓸 수 있다
- 서버에서 권한을 바꿀 수 있으므로, **Worker가 직접 다시 확인한다**: 인터랙션의 `member.permissions`에 MANAGE_GUILD(`1 << 5`) 또는 ADMINISTRATOR(`1 << 3`)가 없으면 거절
- `contexts: [0]`(서버 안에서만). DM에서는 쓸 수 없다
- 옵션 `code`: 베타 초대 코드. `invite_codes` 테이블에서 남은 사용 횟수를 확인한다
- 이미 연결된 서버면 현재 연결을 보여주고 "다시 연결하려면 `/disconnect` 먼저"라고 답한다
- 응답은 본인에게만 보이는(ephemeral) 메시지와 링크 버튼

**링크 토큰**: `{guild_id, channel_id, discord_user_id, nonce, exp}`를 새 비밀값 `CONNECT_SIGNING_KEY`로 HMAC 서명. 유효 10분. `nonce`는 `connect_sessions` 테이블에 저장해서 **한 번만** 쓰게 한다.

### 2. `/connect/start` (브라우저)

- 토큰 서명, 만료, 사용 여부 확인
- 쿠키 `__Host-ftp_connect=<nonce>` 설정 (HttpOnly, Secure, SameSite=Lax, 15분)
- `https://github.com/apps/<앱 slug>/installations/new`로 302 이동

GitHub 설치 화면에 `state`를 넘길 수 있는지는 문서에서 확인하지 못했다. 그래서 **연결 세션을 쿠키로 이어 간다**. `state`에 기대지 않는다.

### 3. Setup URL `/connect/github/setup`

GitHub 문서는 이 주소에 붙는 `installation_id`를 **위조될 수 있으니 믿지 말라**고 하고, 설치한 사용자의 토큰으로 확인하라고 권한다.

- 쿠키의 nonce로 연결 세션을 찾는다. 없거나 만료면 "Discord에서 /connect를 다시 실행하세요" 화면
- `installation_id`를 연결 세션에 **확인 전 값**으로 적는다
- GitHub 사용자 인증으로 이동: `https://github.com/login/oauth/authorize?client_id=<앱 Client ID>&state=<nonce>&redirect_uri=<callback>`
- 이미 설치되어 있어서 "Configure"로 들어온 경우(`setup_action=update`)도 같은 흐름

GitHub App 설정의 "설치 중 사용자 인증 요청" 옵션을 켜면 이 단계가 설치와 합쳐질 수 있다. 동작은 문서로 확인하지 못했으므로, 구현할 때 실제로 시험해 보고 고른다. 위 흐름은 그 옵션 없이도 동작한다.

### 4. OAuth 콜백 `/connect/github/callback`

1. `state`가 쿠키의 nonce와 같은지 확인 (CSRF, 세션 바꿔치기 방지)
2. `code`를 사용자 토큰으로 교환 (앱 Client ID, Client Secret)
3. `GET /user/installations/{installation_id}/repositories`를 사용자 토큰으로 호출
   - 이 API는 **그 사용자가 실제로 권한을 가진 저장소만** 돌려준다. 위조한 `installation_id`면 403/404가 난다
   - `permissions.admin`이 true인 저장소만 후보로 남긴다
4. 후보가 하나면 바로 연결, 여러 개면 고르는 화면 (POST, 폼에 nonce를 넣어 CSRF 확인)
5. **사용자 토큰은 저장하지 않고 버린다.** 저장하는 것은 지금처럼 `installation_id`, `owner`, `repo`뿐

**저장**: 한 트랜잭션(`db.batch`)으로
- `tenants` 행이 없으면 만든다 (id는 무작위, `plan = 'beta'`)
- `discord_guilds (guild_id, tenant_id)`
- `github_repos (tenant_id, installation_id, owner, repo)`
- `invite_codes.uses + 1`, `connect_sessions.used_at` 기록

이미 **다른 테넌트가 연결한 저장소**면 거절한다 (아래 unique 인덱스).

**연결 직후**: 저장소에 `agent:go` 라벨이 없으면 만든다. 봇 토큰으로 `/connect`를 실행한 채널에 연결 완료 메시지를 보낸다.

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

사용량 표는 migration 0005로 먼저 들어갔다 (위). 연결 흐름은 migration 0006으로 추가한다.

```sql
ALTER TABLE tenants ADD COLUMN plan TEXT NOT NULL DEFAULT 'self_hosted';

-- 같은 저장소를 두 테넌트가 연결하지 못하게
CREATE UNIQUE INDEX github_repos_owner_repo ON github_repos (lower(owner), lower(repo));
CREATE INDEX github_repos_installation ON github_repos (installation_id);

CREATE TABLE connect_sessions (
  nonce TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  invite_code TEXT,
  installation_id INTEGER,          -- Setup URL에서 받은 값. 콜백에서 확인 전까지는 믿지 않는다
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE invite_codes (
  code TEXT PRIMARY KEY,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
```

기존 셀프 호스팅 데이터는 그대로 남는다 (`plan = 'self_hosted'`).

## 새 설정값

| 이름 | 용도 |
|---|---|
| `CONNECT_SIGNING_KEY` | `/connect` 링크 토큰 서명 (32바이트 이상 무작위) |
| `GITHUB_APP_SLUG` | 설치 화면 주소 `github.com/apps/<slug>/installations/new` |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | 사용자 인증 (GitHub App 설정 페이지에 있음) |
| `PUBLIC_BASE_URL` | 콜백 주소 생성용 (`https://feedback-to-pr.<account>.workers.dev` 또는 자체 도메인) |
| `LIMIT_REPORTS_PER_USER_HOUR`, `LIMIT_TRIAGE_PER_MONTH`, `LIMIT_AGENT_RUNS_PER_MONTH` | 사용량 제한. 비워 두면 제한 없음 |

## 외부 설정 (사람이 직접)

**GitHub App**
- "Where can this GitHub App be installed?" → **Any account**
- Setup URL: `https://<worker>/connect/github/setup`, "Redirect on update" 켜기
- Callback URL: `https://<worker>/connect/github/callback`
- Client secret 생성

**Discord 애플리케이션**
- Bot → **Public Bot** 켜기
- Installation → Guild Install만, 범위 `bot`, `applications.commands`. 봇 권한은 메시지 보내기, 스레드 만들기 정도만
- 명령을 **전역(global)으로 등록** (`DISCORD_DEV_GUILD_ID` 없이 `npm run register-commands`)

**Anthropic**: 베타 비용 상한을 Console에서 조직 단위로도 걸어 둔다 (이중 안전장치)

## 보안 점검

| 위협 | 막는 방법 |
|---|---|
| 남의 저장소를 내 Discord 서버에 연결 (installation_id 위조) | 사용자 토큰으로 그 사용자의 저장소 관리자 권한 확인. 위조한 id는 API가 거절 |
| 남의 Discord 서버를 내 저장소에 연결 | `/connect`는 그 서버의 관리 권한이 있어야 실행 가능. Worker가 `member.permissions`를 다시 확인 |
| 링크 가로채기, 재사용 | 10분 만료, 1회용 nonce, 쿠키와 `state` 일치 확인 |
| 연결 화면 CSRF | 저장소 선택 POST에 nonce 확인, SameSite 쿠키 |
| 같은 저장소 이중 연결 | unique 인덱스 |
| 사용자 토큰 유출 | 저장하지 않음. 확인 후 즉시 버림 |
| 공개 서버의 신고 폭탄 | 신고자별, 테넌트별 제한. 분류 전에 확인 |
| 우리가 다른 고객의 데이터를 봄 | 호스팅 운영자는 마스킹된 신고를 볼 수 있다. 개인정보처리방침에 적고, 신고 보관 기간(예: 90일) 뒤 삭제 작업을 둔다 |

## 구현 순서 (PR 단위)

1. **사용량 제한** ✅: migration 0005의 `tenant_usage`, 신고자별 제한, 신고 접수와 에이전트 실행 전 확인. 셀프 호스팅에도 바로 쓸모가 있다
2. **연결 흐름**: `/connect`, `/connect/start`, Setup URL, OAuth 콜백, 저장소 선택 화면, 연결 완료 메시지, 라벨 생성. `connect_sessions`, `invite_codes`, unique 인덱스
3. **해제와 상태**: `/disconnect`, `/status`(연결된 저장소, 이번 달 사용량), `installation` 웹훅 처리
4. **공개 전환**: GitHub App·Discord 봇 공개 설정, 전역 명령 등록, 이용약관·개인정보처리방침 페이지, README에 "설치하기" 안내

각 단계는 테스트를 같이 쓴다. 특히 2번은 위조 `installation_id`, 만료·재사용 토큰, 권한 없는 사용자, 이미 연결된 저장소를 테스트로 막는다.

덤으로, 2번이 끝나면 **셀프 호스팅도 `seed.sql` 없이** `/connect`로 연결할 수 있다.

## 정해야 할 것

1. **월 분류 한도를 넘었을 때**: 분류 없이 이슈를 만들까(스팸이 섞임), 신고를 받지 않을까. 추천: 받지 않고 "이번 달 한도에 도달했습니다" 안내
2. **베타 한도 숫자**: 위 표의 기본값(신고자 시간당 5건, 월 분류 200건, 월 실행 10회)으로 시작할지
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
