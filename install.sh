#!/bin/bash
# 安装 / 重启 launchd 服务：常驻的回复助手 + 每天 06:30 的增量记忆和日报。改完代码重跑一次就是重启
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
FRA_HOME=${FRA_HOME:-$HOME/.feishu-reply-assistant}; export FRA_HOME
NODE=$(command -v node) || { echo "找不到 node（要 Node 24+）" >&2; exit 1; }
LABEL=$(FRA_REPO="$DIR" "$NODE" --input-type=module -e "const { loadConfig } = await import(process.env.FRA_REPO + '/lib/config.mjs'); console.log(loadConfig().launchdLabel)") || exit 1  # 路径走环境变量：带引号也不会拼坏
mkdir -p "$FRA_HOME"
rm -f "$FRA_HOME/.no-start"  # 之前 setup 没启动（--no-start），现在启动了：doctor 恢复检查常驻服务
x() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }  # plist 里的路径做 XML 转义
ENVS="<key>PATH</key><string>$(x "$DIR/bin:$PATH")</string>
    <key>HOME</key><string>$(x "$HOME")</string>
    <key>FRA_HOME</key><string>$(x "$FRA_HOME")</string>
    <key>LANG</key><string>zh_CN.UTF-8</string>"

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
cat > "$PLIST" <<EOF1
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$(x "$NODE")</string><string>$(x "$DIR/assistant.mjs")</string></array>
  <key>WorkingDirectory</key><string>$(x "$DIR")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$(x "$FRA_HOME/launchd.out.log")</string>
  <key>StandardErrorPath</key><string>$(x "$FRA_HOME/launchd.err.log")</string>
  <key>EnvironmentVariables</key><dict>
    $ENVS
  </dict>
</dict></plist>
EOF1
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl print "gui/$(id -u)/$LABEL" | grep -E 'state|pid' | head -3

# 每日增量记忆 + 日报卡：每天 06:30
DLABEL=$LABEL.daily
DPLIST="$HOME/Library/LaunchAgents/$DLABEL.plist"
cat > "$DPLIST" <<EOF2
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$DLABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$(x "$DIR/scripts/daily.sh")</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>$(x "$FRA_HOME/daily.log")</string>
  <key>StandardErrorPath</key><string>$(x "$FRA_HOME/daily.log")</string>
  <key>EnvironmentVariables</key><dict>
    $ENVS
  </dict>
</dict></plist>
EOF2
launchctl bootout "gui/$(id -u)/$DLABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DPLIST"
echo "日志：tail -f $FRA_HOME/assistant.log ；每日增量：$FRA_HOME/daily.log"
