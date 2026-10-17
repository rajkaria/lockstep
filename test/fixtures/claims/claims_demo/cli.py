import click


@click.group()
@click.version_option()
def cli():
    """The claims demo CLI."""


@cli.command()
@click.option("--force", "-f", is_flag=True, help="Overwrite local changes.")
def pull(force):
    """Pull the latest data."""


@cli.command()
@click.option("--all", "push_all", is_flag=True, help="Push every branch.")
def push(push_all):
    """Push local data."""
