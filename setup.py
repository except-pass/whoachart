import os
import setuptools
    
with open("README.md", "r") as fh:
    long_description = fh.read()

with open("requirements.txt", "r") as fh:
    install_requires = fh.readlines()

project = 'whoachart'

with open(os.path.join(project, "__version__"), "r") as fh:
    version = fh.read()
    version = version.strip()

setuptools.setup(
    name=project,
    version=version,
    author="Will Gathright",
    author_email="gathright@gmail.com",
    description="Executable flowcharts for humans and machines",
    long_description=long_description,
    long_description_content_type="text/markdown",
    packages=setuptools.find_packages(),
    install_requires=install_requires,
    classifiers=[
        "Programming Language :: Python :: 3",
        "Operating System :: OS Independent",
    ],
)