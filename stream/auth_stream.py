import os, asyncio
from dotenv import load_dotenv
from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError

load_dotenv("/home/ogma/ogma/stream/.env")

api_id = int(os.environ["TELEGRAM_API_ID"])
api_hash = os.environ["TELEGRAM_API_HASH"]
phone = os.environ["TELEGRAM_PHONE"]
session_path = os.path.expanduser(os.environ["TELEGRAM_SESSION"])

# ВАЖНО: не используем "with client:" чтобы Telethon не вызывал .start() и не просил ввод сам
client = TelegramClient(session_path, api_id, api_hash)

async def main():
    # Убедимся, что каталог для файла сессии существует
    os.makedirs(os.path.dirname(session_path), exist_ok=True)

    await client.connect()
    if not await client.is_user_authorized():
        print("Not authorized yet → sending code to", phone)
        await client.send_code_request(phone)
        code = input("Enter the code from Telegram: ").strip()
        try:
            await client.sign_in(phone=phone, code=code)
        except SessionPasswordNeededError:
            pwd = input("Enter your 2FA password: ").strip()
            await client.sign_in(password=pwd)

    me = await client.get_me()
    print("Authorized as:", me.username or me.id)
    await client.disconnect()

if __name__ == "__main__":
    asyncio.run(main())
