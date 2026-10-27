#!/usr/bin/env bash
# Decides whether a CI run builds the image and deploys it. Writes
#   image=true|false   build and publish the image
#   deploy=true|false  deploy it (the deploy job keeps its own branch/event rules)
# to $GITHUB_OUTPUT, and shows the reason as an annotation.
#
# - Not a push (pull request, workflow_dispatch): build, and deploy as before.
# - A push compares the branch with the last commit DEPLOYED to production from
#   it (GitHub deployments of this repo, not just the previous push: a run whose
#   tests or deploy failed leaves its changes pending). When every changed file
#   matches NO_IMAGE_RE (tests, e2e, docs…) the image would be the same: no
#   build, no deploy. The tests still run.
# - «[skip deploy]» (or «[no deploy]») in the last commit's message: build and
#   publish the image, don't deploy it. The next deploy carries those changes.
# Anything unexpected (no deployment found, history rewritten, API error) builds
# and deploys, as before this script existed.
#
# Env: NO_IMAGE_RE (extended regexp of paths outside the image), EVENT, REF_NAME,
# REPO, HEAD_MESSAGE, GH_TOKEN. Run locally with GITHUB_OUTPUT=/dev/stdout.
set -uo pipefail

decide () {
  echo "image=$1" >> "$GITHUB_OUTPUT"
  echo "deploy=$2" >> "$GITHUB_OUTPUT"
  echo "::notice title=build $1, deploy $2::$3"
  exit 0
}

[ "$EVENT" = push ] || decide true true "$EVENT run"

skip=false
if grep -qiE '\[(skip|no)[ _-]deploy\]' <<< "${HEAD_MESSAGE:-}"; then skip=true; fi
deploy=$([ "$skip" = true ] && echo false || echo true)
why_skip=$([ "$skip" = true ] && echo " ([skip deploy] in the commit message)" || echo "")

# the newest deployment of this branch whose latest status is success
last=""
ids=$(gh api "repos/$REPO/deployments?environment=production&ref=$REF_NAME&per_page=30" --jq '.[].id' 2>/dev/null) || ids=""
for id in $ids; do
  state=$(gh api "repos/$REPO/deployments/$id/statuses?per_page=1" --jq '.[0].state' 2>/dev/null) || state=""
  if [ "$state" = success ]; then
    last=$(gh api "repos/$REPO/deployments/$id" --jq '.sha' 2>/dev/null) || last=""
    break
  fi
done

if [ -z "$last" ]; then
  decide true "$deploy" "no successful deployment of $REF_NAME found: building$why_skip"
fi
if ! git cat-file -e "$last^{commit}" 2>/dev/null || ! git merge-base --is-ancestor "$last" HEAD; then
  decide true "$deploy" "last deployed ${last:0:7} is not in this branch's history: building$why_skip"
fi

changed=$(git diff --name-only "$last" HEAD)
relevant=$(grep -vE "$NO_IMAGE_RE" <<< "$changed" | grep -v '^$' || true)
if [ -z "$relevant" ]; then
  decide false false "nothing that goes into the image changed since the deployed ${last:0:7}: no build, no deploy"
fi
count=$(wc -l <<< "$relevant")
decide true "$deploy" "$count file(s) of the image changed since the deployed ${last:0:7} (first: $(head -1 <<< "$relevant"))$why_skip"
