"""Skriver ut dagens dato."""
from datetime import date


def main() -> None:
    print(f"Dagens dato er {date.today():%d.%m.%Y}")


if __name__ == "__main__":
    main()
