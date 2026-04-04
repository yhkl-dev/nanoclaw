# 任务状态监控使用示例

## 1. 基础用法

### 执行定时任务并监控状态
```bash
python3 /home/orangepi/github.com/nanoclaw/task_status_monitor.py "your_command_here" "任务名称"
```

**示例：**
```bash
python3 /home/orangepi/github.com/nanoclaw/task_status_monitor.py "echo 'Hello' - 测试任务" "测试任务"
```

## 2. 与 crontab 集成

### 在 crontab 中添加监控任务
```bash
# 每天凌晨 2 点执行备份任务并监控
0 2 * * * python3 /home/orangepi/github.com/nanoclaw/task_status_monitor.py "/home/orangepi/backup.sh" "每日数据备份"
```

### 查看 crontab
```bash
crontab -l
```

## 3. 修改邮件通知配置

编辑脚本 `/home/orangepi/github.com/nanoclaw/task_status_monitor.py`，修改以下部分：

```python
# 发送通知的邮箱地址
def send_email_notification(result, to_email="kaiyang939325@gmail.com"):
    # ...
```

### SMTP 配置
```python
server.login('yangkai@163.com', 'YOUR_SMTP_PASSWORD')
# 替换为你的 163 邮箱 SMTP 授权码
```

## 4. 发送所有状态通知（成功和失败都通知）

如果需要成功也发送邮件，可以这样修改：

```python
if __name__ == "__main__":
    result = run_task(task_script, task_name)
    
    # 所有状态都通知
    send_email_notification(result)
    
    sys.exit(0 if result['success'] else 1)
```

## 5. 测试脚本

```bash
# 测试执行成功任务
python3 /home/orangepi/github.com/nanoclaw/task_status_monitor.py "echo '任务成功'" "测试任务 - 成功"

# 测试执行失败任务
python3 /home/orangepi/github.com/nanoclaw/task_status_monitor.py "exit 1" "测试任务 - 失败"
```

## 6. 集成到现有的调度任务

如果你使用 `mcp__nanoclaw__schedule_task` 创建任务，可以在任务脚本中添加状态监控：

**创建任务时：**
- 任务脚本：`python3 /home/orangepi/github.com/nanoclaw/task_status_monitor.py "your_real_task_command" "任务名称"`
- 或者直接在 `your_real_task_command` 中执行你的业务逻辑

---

**特点：**
- ✅ 自动检测任务成功/失败
- ✅ 失败时立即发送邮件通知
- ✅ 包含详细输出和错误信息
- ✅ 支持超时控制
- ✅ 可配置通知邮箱

需要我帮你测试这个脚本吗？