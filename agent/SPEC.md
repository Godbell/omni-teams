# omni-teams Agent — Specification & Implementation Plan

> 본 문서는 `agent/` 모듈의 책임 범위와 구현 계획을 정의한다.
>
> **주의**: 온톨로지의 클래스/속성/제약/추론 규칙 등 구체적 스키마는 별도 합의 전이므로 본 문서에서는 다루지 않는다. 본 문서는 에이전트의 동작 골격에 집중하며, 온톨로지 스키마가 확정되면 별도 문서로 분리한다.

---

## 1. 목적과 스코프

`agent/`는 omni-teams 시스템의 추론 엔진. Microsoft Teams에서 들어오는 비정형 메시지 묶음을 받아 LLM(Claude API)으로 의도를 분류하고, 온톨로지 레포지토리에 영속화하며, 질의에 응답하고 주간 보고서를 생성한다.

**스코프 밖**:
- Teams 메시지 수집 자체 → Power Automate
- HTTP 라우팅, 외부 노출 API → `api/`
- 인프라(Qdrant/GitLab/RDBMS) 운영
- 온톨로지 스키마 설계 (별도 문서)

본 모듈은 정제된 이벤트를 받아 정제된 결과를 돌려준다.

---

## 2. 입출력 계약

### 2.1 입력 이벤트
```ts
type AgentInput =
  | { type: "TEAMS_CHAT";   channel_id: string; messages: Message[]; attachments?: Attachment[] }
  | { type: "TEAMS_FILE";   channel_id: string; file: Attachment }
  | { type: "TEAMS_POST";   channel_id: string; post: Post }
  | { type: "QUERY";        channel_id: string; question: string }
  | { type: "REPORT_REQUEST"; channel_id: string; range: { from: string; to: string } };

interface Message { author: string; text: string; ts: string /* ISO8601 */; }
```

### 2.2 출력
- **채팅 회신**: 구조화된 자연어 텍스트 (Teams 채팅으로 푸시)
- **보고서 산출물**: Markdown(필수) / PDF / PPTX
- **부수효과**: 온톨로지 레포지토리에 Git commit, Qdrant 임베딩 갱신

---

## 3. 내부 아키텍처

```
agent/
├── src/
│   ├── orchestrator/   # 의도 분류 — NEW_TASK | UPDATE_TASK | ISSUE | QUERY | REPORT | SCHEDULE
│   ├── trigger/        # 채널별 메시지 버퍼, 침묵·키워드·타이머 감지
│   ├── crud/           # 온톨로지 파일 생성·수정 + git commit
│   ├── query/          # Graph RAG · git blame · git log · RDBMS
│   ├── report/         # 주간 보고서 빌더
│   ├── ontology/       # 스키마 검증 · 제약 · 추론 (스키마 확정 후 채움)
│   ├── llm/            # Claude API 클라이언트, ROLE.md 컨텍스트, prompt cache
│   ├── stores/         # git / qdrant / rdbms 어댑터
│   └── index.ts
├── role/
│   └── ROLE.md         # 에이전트 페르소나 + 행동 지침 (system prompt)
└── package.json        # ESM, Node.js
```

서브에이전트 간 호출은 **병렬 실행**(Promise.all)으로 처리. 메시지 큐는 본 규모에서 오버엔지니어링 — 도입하지 않는다. 에이전트 간 데이터는 **Zod 스키마**로 정의해 타입 안정성 확보.

---

## 4. 트리거 엔진

채널별 버퍼에 메시지를 누적하다 다음 조건 중 하나라도 만족되면 처리 파이프라인을 발화한다.

| 조건 | 의미 | 기본 임계값 |
|---|---|---|
| 침묵 감지 | 마지막 메시지 후 무발화 시간 경과 | 60초 |
| 키워드 감지 | 즉각 처리 키워드 매칭 (`@bot`, `/report` 등) | — |
| 배치 타이머 | 폴백, 최대 누적 시간 | 60분 |

**동시성**: `is_processing` 플래그로 채널 단위 직렬화. 처리 중 새 메시지는 다음 버퍼로 분리되어 자연스럽게 누적. 한 채널의 처리 흐름은 절대 중첩되지 않는다.

---

## 5. 의도 분류 (Orchestrator)

LLM 호출로 메시지 묶음을 다음 이벤트 타입에 매핑.

```
NEW_TASK | UPDATE_TASK | ISSUE | QUERY | REPORT | SCHEDULE
```

복합 이벤트 허용 (예: `NEW_TASK + ISSUE`). 분류 결과는 Zod 스키마로 검증 후 다운스트림 에이전트로 분기.

LLM 응답에서 **tool_use 블록**을 파싱해 다음 도구 호출 여부를 결정:
- `git`: 파일 시스템 + 커밋 + 이력
- `qdrant_search`: 의미 기반 검색
- `sparql_query`: 구조적 그래프 질의
- `ecm`: (선택) 외부 문서 시스템

---

## 6. 데이터 레이어

| 저장소 | 역할 | 클라이언트 |
|---|---|---|
| Git (GitLab) | 온톨로지 파일 본문, 커밋 이력 (~1년) | `simple-git` 또는 git CLI |
| Qdrant | 청크 임베딩 + payload 필터 | `@qdrant/js-client-rest` |
| RDBMS | 1년 이상 커밋 메타(id/tag/date/author) | Drizzle/Prisma + Postgres |

### 6.1 Git ↔ Qdrant 동기화

청킹 시 **메타데이터 헤더를 모든 청크에 prepend**한다 — 단순 문단 분할은 RAG 품질을 망친다. 헤더의 구조적 필드는 Qdrant payload에 1:1로 매핑되어 벡터 유사도 + 구조적 필터를 동시에 사용한다. 구체적 필드 목록은 온톨로지 스키마 확정 후 결정.

후속 커밋의 변경 파일만 인크리멘털로 재임베딩(post-commit hook 또는 폴링 워커).

### 6.2 커밋 메시지 규약

시맨틱 태그를 사용해 후속 쿼리(태그·기간·작성자 기반)를 단순화한다. 태그 어휘는 온톨로지 액션 모델 확정과 함께 결정.

### 6.3 이력 조회 깊이별 전략

```
최근 ~1년   → git blame / git log -p
1년 이상    → RDBMS 쿼리 (연말 배치로 메타데이터만 이관)
```

---

## 7. LLM 통합

- **모델**: 기본 `claude-sonnet-4-6`, 복잡한 분류·보고서는 `claude-opus-4-7`
- **컨텍스트**: `agent/role/ROLE.md`를 system prompt로 주입. 페르소나 + 의도 분류 기준 + 출력 포맷 규칙
- **Prompt caching**: ROLE.md + 자주 참조하는 온톨로지 헤더 묶음을 캐시 — 매 호출의 비용/지연 감소
- **Tool use**: `git_*`, `qdrant_search`, `sparql_query`, `ontology_validate` 도구를 정의해 LLM이 직접 호출
- **후순위**: Ollama 로컬 어댑터 (사내망 폐쇄 환경 대비)

---

## 8. 보고서 생성

| 형식 | 도구 | 용도 |
|---|---|---|
| Markdown | 자체 템플릿 | 기본, Git에 커밋 |
| PDF (표 중심) | WeasyPrint | 공식 보고 |
| PPTX (1페이지) | python-pptx | 회의용 슬라이드 |

WeasyPrint/python-pptx는 Python 라이브러리이므로 `api/`측 사이드카로 호출하거나 `pandoc` CLI 로 대체. `agent/`는 보고서 데이터(JSON) 생성까지만 담당하는 안을 우선 검토.

---

## 9. 구현 로드맵

### Phase 1 — 골격
- [ ] `src/llm/` Claude API 클라이언트 + prompt caching
- [ ] `src/stores/git/` 어댑터 (read/write/commit/log/blame)
- [ ] `role/ROLE.md` 초안
- [ ] 입출력 계약 Zod 정의 + 단위 테스트

### Phase 2 — Happy Path E2E (온톨로지 스키마 확정 후)
- [ ] Orchestrator: 메시지 묶음 → 의도 분류
- [ ] CRUD: `NEW_TASK` → 파일 생성 + 커밋
- [ ] 온톨로지 제약 검증
- [ ] Teams 모의 입력 픽스처

### Phase 3 — 질의
- [ ] Qdrant 어댑터 + 인크리멘털 임베딩 워커
- [ ] Query Agent: Graph RAG + git blame/log 융합

### Phase 4 — 트리거 / 동시성
- [ ] 채널 버퍼 + 침묵·키워드·타이머 감지
- [ ] `is_processing` 플래그
- [ ] 동시 채널 부하 테스트

### Phase 5 — 보고서 / 추론
- [ ] Report Agent: 주간 보고서 Markdown
- [ ] WeasyPrint / python-pptx 사이드카 연동
- [ ] 추론 규칙 구현

### Phase 6 — 운영
- [ ] 연말 RDBMS 이관 배치
- [ ] Power Automate 리마인드 트리거 연동
- [ ] 관측성: 구조화 로깅, 도구 호출 메트릭, 비용 추적

---

## 10. 미결 사항

1. **언어 선택**: 본 `agent/`는 Node.js(ESM)로 초기화됐으나 일부 설계 자료는 Python(LangGraph+FastAPI) 전제. 결정 필요:
   - (A) `agent/` = TypeScript 오케스트레이터, `api/` = Python FastAPI + RAG 백엔드
   - (B) `agent/`를 Python으로 전환
2. **온톨로지 스키마**: 클래스, 속성, 관계, 제약, 추론 규칙, 디렉토리 구조 — 본 문서 외부에서 합의 후 별도 문서로 작성.
3. **세션 키**: Teams 채널을 그대로 컨텍스트 키로 쓸지, 워크스페이스 매핑을 둘지.
4. **권한 모델**: 어떤 사용자가 어떤 파일을 조작할 수 있는지 정책 미정.
5. **임베딩 모델**: Claude는 임베딩 미제공 → Voyage / OpenAI / 사내 모델 중 결정.
