# LightBoard illustration status plugin

RisuAI의 생성 이벤트를 감지해 삽화 서버 진행 상태를 표시하는 보조 플러그인입니다. 메시지·채팅 인덱스·이미지는 플러그인이 읽거나 전송하지 않으며, 이미지 생성 자체는 모듈이 담당합니다.

배포 파일은 `lightboard_illust_status.js` 하나입니다. 파일명과 GitHub 경로는 앞으로 고정하고, 릴리스마다 `//@version`만 증가시킵니다.

## 최초 GitHub 설정

1. 공개 저장소 `lbh848/LB_plugin`과 기본 브랜치 `main`을 유지합니다.
2. 이 폴더를 저장소에 push합니다.
3. 다음 raw URL을 브라우저에서 열어 JS 원문이 표시되는지 확인합니다.

   `https://raw.githubusercontent.com/lbh848/LB_plugin/main/lightboard_illust_status.js`

4. RisuAI 플러그인 설정의 맨 위 `+` 버튼으로 이 JS 파일을 한 번 직접 설치합니다.

현재 기존 설치본에는 `update-url`이 없으므로 이 최초 1회 수동 설치가 필요합니다. 같은 내부 이름의 플러그인이 있다는 확인창이 뜨면 업데이트를 승인합니다. 그 뒤부터 원격 파일의 버전이 설치본보다 높으면 설치된 플러그인 항목 옆에 녹색 `+` 업데이트 버튼이 나타납니다.

Risu의 맨 위 `+`는 파일 가져오기 버튼이고, 설치된 플러그인 오른쪽의 녹색 `+`가 온라인 업데이트 버튼입니다. 둘은 다른 버튼입니다.

## 일반 사용

1. 플러그인의 `Open LightBoard dashboard`를 누릅니다.
2. HTTPS 서버 주소를 입력하고 `Save & check`를 누릅니다.
3. generation, CALL1부터 시작하는 전체 재생성, raw 전체 생성, 이미지별 raw 재생성 때 진행창이 표시됩니다.
4. 진행창 표시를 꺼도 생성 연동과 필요한 동안의 상태 확인은 계속 작동합니다.

서버 주소를 저장하기 전에는 요청하지 않으며, 평소에는 폴링하지 않습니다. 생성 신호가 있거나 대시보드를 열어 직접 확인할 때만 서버 상태를 조회합니다.

호환 구성은 soya-v42 모듈과 illustration context bridge version 5 서버입니다. 모듈은 이미지와 실제 슬롯을 Risu 인레이 경로로 직접 처리하며, 플러그인이 꺼져 있어도 이미지 생성 기능은 독립적으로 작동합니다.

## 업데이트 배포

코드를 수정한 뒤 `//@version`을 반드시 이전 공개 버전보다 높이고 `./verify.ps1`을 실행한 다음 commit/push합니다. GitHub raw 캐시가 갱신된 뒤 RisuAI에서 업데이트 확인을 하면 녹색 `+`가 나타납니다.

Risu의 플러그인 교체 과정은 헤더 `//@arg` 사용자 값을 기본값으로 다시 만들 수 있습니다. 서버 주소는 플러그인 저장소와 캐릭터 변수에도 저장되므로 유지되지만, 폴링 간격 등을 직접 바꿨다면 업데이트 후 다시 확인하십시오.

자세한 불변 조건과 과거 문제는 [DEVELOPMENT.md](DEVELOPMENT.md), 배포 순서는 [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md)를 참고하십시오.
