#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
任务状态监控器
在任务执行后检查状态并发送邮件通知
"""
import subprocess
import json
import sys
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime

def run_task(task_script, task_name="任务"):
    """执行任务脚本并返回结果"""
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] 开始执行任务：{task_name}")
    
    try:
        result = subprocess.run(
            ['bash', '-c', task_script],
            capture_output=True,
            text=True,
            timeout=3600  # 1 小时超时
        )
        
        success = result.returncode == 0
        output = result.stdout.strip()
        error = result.stderr.strip()
        
        print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] 任务完成：{task_name}")
        print(f"状态：{'✅ 成功' if success else '❌ 失败'}")
        
        return {
            "success": success,
            "task_name": task_name,
            "output": output,
            "error": error,
            "timestamp": datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            "returncode": result.returncode
        }
    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "task_name": task_name,
            "output": "",
            "error": "任务执行超时",
            "timestamp": datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            "returncode": -1
        }
    except Exception as e:
        return {
            "success": False,
            "task_name": task_name,
            "output": "",
            "error": str(e),
            "timestamp": datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            "returncode": -1
        }

def send_email_notification(result, to_email="kaiyang939325@gmail.com"):
    """发送任务状态邮件通知"""
    subject = f"[任务状态] {'✅ 成功' if result['success'] else '❌ 失败'}: {result['task_name']}"
    
    body = f"""任务名称：{result['task_name']}
执行时间：{result['timestamp']}
返回状态：{'✅ 成功' if result['success'] else '❌ 失败'}
退出码：{result['returncode']}

--- 任务输出 ---
{result['output'] if result['output'] else '无输出'}

--- 错误信息 ---
{result['error'] if result['error'] else '无错误'}
"""
    
    msg = MIMEMultipart()
    msg['From'] = 'yangkai@163.com'
    msg['To'] = to_email
    msg['Subject'] = subject
    msg.attach(MIMEText(body, 'plain', 'utf-8'))
    
    try:
        server = smtplib.SMTP_SSL('smtp.163.com', 465)
        server.login('yangkai@163.com', 'YOUR_SMTP_PASSWORD')
        server.send_message(msg)
        server.quit()
        print(f"✅ 通知邮件已发送到 {to_email}")
        return True
    except Exception as e:
        print(f"❌ 发送邮件失败：{e}")
        return False

if __name__ == "__main__":
    # 使用示例：
    # python3 task_status_monitor.py "echo 'Hello World' - 测试任务" "测试任务"
    if len(sys.argv) >= 2:
        task_script = sys.argv[1]
        task_name = sys.argv[2] if len(sys.argv) >= 3 else "未命名任务"
    else:
        task_script = input("请输入要执行的任务脚本：")
        task_name = input("请输入任务名称：") or "未命名任务"
    
    result = run_task(task_script, task_name)
    
    # 任务失败时发送邮件通知
    if not result['success']:
        send_email_notification(result)
    
    sys.exit(0 if result['success'] else 1)
