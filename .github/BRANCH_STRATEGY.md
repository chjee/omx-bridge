# 브랜치 전략

## 구조

- `main` — 배포용 (안정 버전). 직접 커밋 금지.
- `develop` — 개발 기본 브랜치. 여기서 분기하고 여기로 머지.
- `feature/이름` — 기능 개발 브랜치 (develop에서 분기)
- `fix/이름` — 버그픽스 브랜치 (develop에서 분기)

## 작업 흐름

```bash
# 새 기능 시작
git checkout develop
git pull origin develop
git checkout -b feature/새기능이름

# 작업 후 develop으로 PR
git push origin feature/새기능이름
# GitHub에서 PR: feature/새기능이름 → develop

# develop → main은 릴리즈 시점에 PR
```

## Codex/OMX 작업 시

Codex에게 작업 지시할 때 항상 브랜치 명시:
```
develop 브랜치에서 feature/xxx 브랜치 만들어서 작업해줘
```

## 규칙

- `main`에 직접 push 금지
- 모든 변경은 PR로 머지
- 커밋 메시지는 Lore 프로토콜 준수 (why 중심)
