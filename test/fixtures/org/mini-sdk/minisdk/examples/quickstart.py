import asyncio

from minisdk import Rag


async def main():
    rag = Rag("kg")
    await rag.ingest("hello")
    print(await rag.ask("hello"))


asyncio.run(main())
